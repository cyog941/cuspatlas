import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AgentHandle,
  type AgentStack,
  allScopes,
  SPONSOR,
  startAgentStack,
} from './support/agent-stack';
import { T_ALPHA } from './support/fixtures';
import { patientBody } from './support/patient-fixtures';

/**
 * A10: prepare/commit generalized to the catalog operations marked `approval: proposal` (the A-D4
 * grey-zone set: portal enrolment, consent record, relationship add, payment-plan authorization).
 * An agent may PREPARE them; a human distinct from the proposer and from the proposer's sponsor
 * approves; a human commits through the owning command, reauthorized at commit, executed once per
 * proposal. Synthetic data only.
 */
let s: AgentStack;
let agent: AgentHandle;
let approver: string;
let patient: string;
let counterparty: string;

const AGENT_SCOPES = [
  'patients.read',
  'patients.write',
  'communications.write',
  'actions.prepare',
  'actions.read',
];

async function newPatient(name: string): Promise<string> {
  const r = await s.call('humanAll', 'POST', '/v1/patients', patientBody(name));
  if (r.status !== 201) throw new Error(`patient create failed ${r.status}`);
  return (r.body.data as { patientRef: string }).patientRef;
}
const relationship = (subject: string) => ({
  operation: 'patients.relationships.add',
  payload: { patientRef: subject, counterpartyRef: counterparty, kind: 'guarantor', scopes: ['financial'] },
});
const consentFact = (subject: string) => ({
  operation: 'communications.consents.record',
  payload: {
    patientRef: subject,
    channel: 'email',
    purpose: 'reminders',
    state: 'granted',
    source: 'staff_recorded',
    consentVersion: 'synthetic-consent-1',
  },
});

async function prepareAsAgent(body: unknown) {
  const r = await s.agentTool(agent, 'actions_proposals_prepare', {
    ...(body as object),
    idempotencyKey: randomUUID(),
  });
  if (r.isError) throw new Error(`prepare failed ${JSON.stringify(r.body)}`);
  return r.body.data as {
    proposalRef: string;
    payloadDigest: string;
    state: string;
    sponsorRef: string | null;
  };
}
const approve = (who: string, p: { proposalRef: string; payloadDigest: string }, expectedVersion = 1) =>
  s.call(who, 'POST', '/v1/actions/proposals/approve', {
    proposalRef: p.proposalRef,
    payloadDigest: p.payloadDigest,
    expectedVersion,
  });
const commit = (who: string, p: { proposalRef: string; payloadDigest: string }, key?: string) =>
  s.call(
    who,
    'POST',
    '/v1/actions/proposals/commit',
    { proposalRef: p.proposalRef, payloadDigest: p.payloadDigest },
    key,
  );

beforeAll(async () => {
  s = await startAgentStack('action_proposals');
  approver = randomUUID();
  await s.db.admin.query(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'human', 'proposal-approver')`,
    [approver],
  );
  await s.db.admin.query(
    'INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3)',
    [T_ALPHA, approver, allScopes],
  );
  agent = await s.createAgent(AGENT_SCOPES, 'proposal agent');
  patient = await newPatient('Proposa');
  counterparty = await newPatient('Guardiana');
}, 120_000);
afterAll(async () => {
  await s?.close();
});

describe('A10 agent may prepare, human approves', () => {
  it('an agent calling an elevated operation directly is told to prepare a proposal', async () => {
    const r = await s.agentTool(agent, 'patients_add_relationship', {
      ...relationship(patient).payload,
      idempotencyKey: randomUUID(),
    });
    expect(r.body.code).toBe('forbidden');
    expect(s.attempts.some((x) => x.actorId === agent.agentRef && x.reasonCode === 'proposal_required')).toBe(
      true,
    );
  });

  it('prepare binds digest, sponsor and expiry; the agent and its sponsor cannot approve', async () => {
    const p = await prepareAsAgent(relationship(patient));
    expect(p.state).toBe('prepared');
    expect(p.sponsorRef).toBe(SPONSOR);
    const byAgent = await s.agentTool(agent, 'actions_proposals_approve', {
      ...p,
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    });
    expect(byAgent.body.code).toBe('forbidden');
    const bySponsor = await approve('humanAll', p);
    expect(bySponsor.status).toBe(403);
    expect(bySponsor.body.code).toBe('self_approval_denied');
    const ok = await approve(approver, p);
    expect(ok.status).toBe(200);
    expect((ok.body.data as { state: string }).state).toBe('approved');
  });

  it('commit runs the owning command once; a repeat replays; the agent cannot commit', async () => {
    const p = await prepareAsAgent(relationship(await newPatient('Commita')));
    await approve(approver, p);
    const agentCommit = await s.agentTool(agent, 'actions_proposals_commit', {
      ...p,
      idempotencyKey: randomUUID(),
    });
    expect(agentCommit.body.code).toBe('forbidden');
    const first = await commit(approver, p);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const d = first.body.data as { state: string; result: { ref: string } };
    expect(d.state).toBe('committed');
    const again = await commit(approver, p);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    const { rowCount } = await s.db.admin.query(
      'SELECT 1 FROM cuspatlas.patient_relationships WHERE id = $1',
      [d.result.ref],
    );
    expect(rowCount).toBe(1);
  });

  it('two concurrent commits of one proposal produce one effect', async () => {
    const subject = await newPatient('Concurra');
    const p = await prepareAsAgent(relationship(subject));
    await approve(approver, p);
    const key = randomUUID();
    const [a, b] = await Promise.all([commit(approver, p, key), commit(approver, p, key)]);
    expect([a.status, b.status].filter((x) => x === 200).length).toBeGreaterThanOrEqual(1);
    const { rows } = await s.db.admin.query<{ n: string }>(
      'SELECT count(*) AS n FROM cuspatlas.patient_relationships WHERE subject_patient_id = $1',
      [subject],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('a commit with a digest other than the approved one is refused and closes the proposal', async () => {
    const p = await prepareAsAgent(consentFact(patient));
    await approve(approver, p);
    const bad = await commit(approver, { ...p, payloadDigest: 'f'.repeat(64) });
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('payload_mismatch');
    const read = await s.call('humanAll', 'GET', `/v1/actions/proposals/state?proposalRef=${p.proposalRef}`);
    expect((read.body.data as { state: string }).state).toBe('rejected');
  });

  it('a commit after the affected record changed is stale; an expired proposal cannot commit', async () => {
    const subject = await newPatient('Stalia');
    const p = await prepareAsAgent(consentFact(subject));
    await approve(approver, p);
    await s.db.admin.query('UPDATE cuspatlas.patients SET version = version + 1 WHERE id = $1', [subject]);
    const stale = await commit(approver, p);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('stale_version');
    const q = await prepareAsAgent(consentFact(patient));
    await approve(approver, q);
    await s.db.admin.query(
      `UPDATE cuspatlas.operation_proposals SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [q.proposalRef],
    );
    const expired = await commit(approver, q);
    expect(expired.status).toBe(409);
    expect(expired.body.code).toBe('proposal_expired');
  });

  it('a human cannot approve a proposal the same human prepared', async () => {
    const r = await s.call('humanAll', 'POST', '/v1/actions/proposals', consentFact(patient));
    expect(r.status).toBe(201);
    const p = r.body.data as { proposalRef: string; payloadDigest: string };
    expect((await approve('humanAll', p)).body.code).toBe('self_approval_denied');
  });

  it('a revoked proposer invalidates the proposal at commit', async () => {
    const short = await s.createAgent(AGENT_SCOPES, 'revoked proposer');
    const prep = await s.agentTool(short, 'actions_proposals_prepare', {
      ...consentFact(patient),
      idempotencyKey: randomUUID(),
    });
    const p = prep.body.data as { proposalRef: string; payloadDigest: string };
    await approve(approver, p);
    await s.call('humanAll', 'POST', '/v1/agents/principals/revoke', {
      agentRef: short.agentRef,
      expectedVersion: short.version,
      reason: 'synthetic_test',
    });
    const r = await commit(approver, p);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('approval_invalid');
  });

  it('another tenant cannot read or commit a proposal; an abandoned one cannot be revived', async () => {
    const p = await prepareAsAgent(consentFact(patient));
    expect(
      (await s.call('humanBeta', 'GET', `/v1/actions/proposals/state?proposalRef=${p.proposalRef}`)).status,
    ).toBe(404);
    expect((await commit('humanBeta', p)).status).toBe(404);
    const ab = await s.agentTool(agent, 'actions_proposals_abandon', {
      proposalRef: p.proposalRef,
      expectedVersion: 1,
      reason: 'no_longer_needed',
      idempotencyKey: randomUUID(),
    });
    expect(ab.isError).toBe(false);
    expect((await approve(approver, p, 2)).status).toBe(409);
    const listed = await s.call('humanAll', 'GET', '/v1/actions/proposals?state=abandoned');
    expect(
      (listed.body.items as { proposalRef: string }[]).some((x) => x.proposalRef === p.proposalRef),
    ).toBe(true);
  });

  it('every proposal step is audited, the agent steps in the agent-audit stream', async () => {
    const { rows } = await s.db.admin.query<{ operation: string }>(
      `SELECT DISTINCT operation FROM cuspatlas.audit_events WHERE resource_type = 'operationProposal'`,
    );
    expect(rows.map((r) => r.operation).sort()).toEqual(
      expect.arrayContaining([
        'actions.proposals.prepare',
        'actions.proposals.approve',
        'actions.proposals.commit',
      ]),
    );
    const agentRows = await s.db.admin.query(
      `SELECT 1 FROM cuspatlas.agent_audit_events WHERE agent_ref = $1 AND operation = 'actions.proposals.prepare'`,
      [agent.agentRef],
    );
    expect(agentRows.rowCount).toBeGreaterThan(0);
  });
});

describe('A10 catalog marking', () => {
  it('the catalog marks exactly the proposal-only operations, and the domain registry matches', async () => {
    const { catalog } = await import('./support/agent-stack');
    const { ELEVATED_OPERATION_NAMES, PROPOSAL_REQUIRED_FOR_AGENTS } = await import('@cuspatlas/domain');
    const marked = catalog
      .filter((o) => o.approval === 'proposal')
      .map((o) => o.operation)
      .sort();
    expect(marked).toStrictEqual([...PROPOSAL_REQUIRED_FOR_AGENTS].sort());
    expect([...ELEVATED_OPERATION_NAMES].sort()).toStrictEqual(marked);
  });
});
