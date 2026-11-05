import { randomUUID } from 'node:crypto';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { createAgentService, createAuthorize, type PrescribingPort } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentStack, startAgentStack } from './support/agent-stack';
import { ctxFor, T_ALPHA } from './support/fixtures';

/**
 * A13: the prescribing operation envelope and refusal semantics. No e-prescribing partner is
 * qualified and no prescriber-verification source exists, so every prescribing operation refuses
 * with a typed 503 (reason prescribing_not_available) naming each missing fact and capability, and
 * never returns a fabricated success. The contract (draft, submit with an approved proposal, cancel)
 * is shaped for a qualified partner to plug in later. Synthetic data only.
 */
let s: AgentStack;
const draftBody = (controlledSubstance = false) => ({
  patientRef: randomUUID(),
  medication: { name: 'Synthetic amoxicillin', strength: '500 mg', form: 'capsule' },
  sig: 'Synthetic instructions only',
  quantity: 21,
  refills: 0,
  controlledSubstance,
});
const submitBody = () => ({ draftRef: randomUUID(), proposalRef: randomUUID(), expectedVersion: 1 });
type Detail = { reason: string; blockingRefs: { kind: string; ref: string }[] };
const refs = (d: Detail) => d.blockingRefs.map((b) => `${b.kind}:${b.ref}`);

beforeAll(async () => {
  s = await startAgentStack('prescribing_envelope');
}, 120_000);
afterAll(async () => {
  await s?.close();
});

describe('A13 prescribing refusal semantics', () => {
  it('a draft is refused naming the missing partner and the unverified prescriber, never a success', async () => {
    const r = await s.call('humanAll', 'POST', '/v1/prescriptions/drafts', draftBody());
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('service_unavailable');
    const d = r.body.detail as Detail;
    expect(d.reason).toBe('prescribing_not_available');
    expect(refs(d)).toEqual(
      expect.arrayContaining(['capability:eprescribing_partner', 'fact:prescriber_identity_verified']),
    );
  });

  it('a controlled-substance draft also names the controlled-substance capability', async () => {
    const r = await s.call('humanAll', 'POST', '/v1/prescriptions/drafts', draftBody(true));
    expect(refs(r.body.detail as Detail)).toContain('capability:controlled_substance_submission');
  });

  it('submission and cancellation refuse the same way; a malformed request is still 400 first', async () => {
    for (const [url, body] of [
      ['/v1/prescriptions/submit', submitBody()],
      ['/v1/prescriptions/cancel', { draftRef: randomUUID(), expectedVersion: 1, reason: 'synthetic' }],
    ] as const) {
      const r = await s.call('humanAll', 'POST', url, body);
      expect(r.status, url).toBe(503);
      expect((r.body.detail as Detail).reason).toBe('prescribing_not_available');
    }
    expect(
      (await s.call('humanAll', 'POST', '/v1/prescriptions/submit', { draftRef: randomUUID() })).status,
    ).toBe(400);
  });

  it('submission without an approved proposal is not even expressible', async () => {
    const r = await s.call('humanAll', 'POST', '/v1/prescriptions/submit', {
      draftRef: randomUUID(),
      expectedVersion: 1,
    });
    expect(r.status).toBe(400);
  });

  it('agents and services can never prescribe; refusals are forbidden on REST and MCP alike', async () => {
    const svc = await s.call('serviceAll', 'POST', '/v1/prescriptions/submit', submitBody());
    expect(svc.status).toBe(403);
    expect(
      (await s.mcp('serviceAll', 'prescriptions_submit', { ...submitBody(), idempotencyKey: randomUUID() }))
        .code,
    ).toBe('forbidden');
    const a = await s.createAgent(['syntheticTasks.read']);
    const viaMcp = await s.agentTool(a, 'prescriptions_submit', {
      ...submitBody(),
      idempotencyKey: randomUUID(),
    });
    expect(viaMcp.body.code).toBe('forbidden');
    const tok = await s.issuer.issue({ sub: a.agentRef, tid: T_ALPHA, sid: a.credentialRef });
    expect((await s.rest(tok, 'POST', '/v1/prescriptions/submit', submitBody())).statusCode).toBe(403);
  });

  it('a partner reporting every capability still cannot submit without a verified prescriber', async () => {
    let calls = 0;
    const capable: PrescribingPort = {
      partnerRef: 'synthetic-capable-partner',
      capabilities: () => ({ qualified: true, controlledSubstances: true }),
      submit: async () => {
        calls++;
        return { outcome: 'unsupported', reason: 'synthetic_partner' };
      },
    };
    const memberships = createMembershipSource(s.db.app);
    const svc = createAgentService({
      authorize: createAuthorize(memberships),
      withTenantTransaction: createTenantTransactionRunner(s.db.app),
      recording: { sink: createSecurityAttemptSink(s.db.sink), alert: () => undefined },
      prescribing: capable,
    });
    const human = (
      await s.db.admin.query<{ id: string }>(
        `SELECT m.principal_id AS id FROM cuspatlas.memberships m JOIN cuspatlas.principals p ON p.id = m.principal_id
         WHERE m.tenant_id = $1 AND p.kind = 'human' AND 'prescriptions.submit' = ANY (m.scopes) AND m.revoked_at IS NULL LIMIT 1`,
        [T_ALPHA],
      )
    ).rows[0]?.id as string;
    const ctx = ctxFor(T_ALPHA, human, 'human', ['prescriptions.submit', 'prescriptions.draft']);
    await expect(
      svc.submitPrescription(ctx, {
        operation: 'prescriptions.submit',
        idempotencyKey: randomUUID(),
        payload: submitBody(),
      }),
    ).rejects.toMatchObject({
      code: 'service_unavailable',
      detail: {
        reason: 'prescribing_not_available',
        blockingRefs: [{ kind: 'fact', ref: 'prescriber_identity_verified' }],
      },
    });
    expect(calls).toBe(0);
  });
});
