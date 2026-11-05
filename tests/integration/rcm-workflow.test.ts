import { randomUUID } from 'node:crypto';
import { RefusalError } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { createAuthorize, createFakeAttachmentSource, createFakeClearinghouse } from '@cuspatlas/domain';
import { createWorker } from '@cuspatlas/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatient, T_ALPHA } from './support/appointment-fixtures';
import { BILLING_ALL, usd } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { FakeProvider } from './support/fake-provider';
import { ctxFor, SVC_A1, T_BETA, USER_A1, USER_B1 } from './support/fixtures';
import { openRcmHarness, type RcmHarness, SVC_BILLING_WORKER, today } from './support/rcm-fixtures';

/**
 * The closed-loop claims workflow's building blocks (synthetic data; fake clearinghouse and fake object
 * source only): CL-01 visit preparation as a read projection, the CL-04 attachment package bound to a
 * claim version and rechecked before dispatch, CL-08 durable timers delivered by the outbox worker with
 * one owned exception per issue and bounded escalation, a standing policy revoked mid-job, and denials.
 */
let db: TestDatabase;
let r: RcmHarness;
const fake = createFakeClearinghouse();
const objects = createFakeAttachmentSource();
let svc: ReturnType<RcmHarness['service']>;
const scopes = [...BILLING_ALL, 'patients.read', 'patients.write'];
const a1 = () => ctxFor(T_ALPHA, USER_A1, 'human', scopes);
const engine = () => ctxFor(T_ALPHA, SVC_A1, 'service', BILLING_ALL);
const env = (operation: string, payload: unknown) => ({ operation, idempotencyKey: randomUUID(), payload });
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof RefusalError
      ? `${err.code}:${(err.detail as { reason?: string } | undefined)?.reason ?? err.reasonCode ?? ''}`
      : `error:${String(err)}`;
  }
};

async function coverage(patient: string, payerRef: string, withEligibility = true) {
  const ref = r.h.ok<{ data: { coverageRef: string } }>(
    await r.h.call('a1', 'POST', '/v1/rcm/coverages', {
      patientRef: patient,
      payerRef,
      rank: 'primary',
      relationshipToSubscriber: 'self',
      memberRef: `syn-member-${randomUUID().slice(0, 8)}`,
      effectiveFrom: '2026-01-01',
    }),
    201,
  ).data.coverageRef;
  if (withEligibility)
    r.h.ok(
      await r.h.call('a1', 'POST', `/v1/rcm/coverages/${ref}/eligibility`, {
        source: 'fake_adapter',
        serviceDate: today(),
      }),
      201,
    );
  return ref;
}
async function claim(given: string, payerRef: string) {
  const patient = await createPatient(r.h, given);
  const coverageRef = await coverage(patient, payerRef);
  const proc = await r.render(await r.encounter(patient), 'SYN-WF-100');
  r.h.ok(await r.consume(proc));
  const claimRef = (
    await svc.prepareClaim(
      a1(),
      env('rcm.claims.prepare', { patientRef: patient, coverageRef, procedureRefs: [proc] }),
    )
  ).data.claimRef;
  return { patient, coverageRef, claimRef };
}
const version = async (claimRef: string) =>
  r.h.ok<{ data: { version: number } }>(await r.h.call('a1', 'GET', `/v1/rcm/claims/${claimRef}`)).data
    .version;
const policy = async (
  payerRef: string,
  followUpMinutes: number,
  exceptionDueMinutes: number,
  maxEscalations: number,
) =>
  (
    await svc.publishWorkflowPolicy(
      a1(),
      env('rcm.workflowPolicies.publish', {
        payerRef,
        acknowledgementDueMinutes: 0,
        followUpMinutes,
        exceptionDueMinutes,
        maxEscalations,
        writeOffLimit: usd(0),
      }),
    )
  ).data.policyRef;
const submissionPolicy = async () =>
  (await svc.createSubmissionPolicy(a1(), env('rcm.submissionPolicies.create', { maxBilled: usd(100000) })))
    .data.policyRef;

beforeAll(async () => {
  db = await openTestDatabase('rcm_workflow');
  r = await openRcmHarness(db);
  svc = r.service({ claims: fake, attachments: objects });
  await r.publishFee('syn-fee-standard', [['SYN-WF-100', 20000]]);
});

afterAll(async () => {
  await r?.h.close();
  await db?.close();
});

describe('CL-01 visit preparation', () => {
  it('shows each coverage with status, freshness and source, names missing facts, never implies payment', async () => {
    const none = await createPatient(r.h, 'Synthetic Visit None');
    const p0 = await svc.prepareVisit(a1(), none, { serviceDate: today() });
    expect([p0.ready, p0.missing.map((m) => m.code)]).toStrictEqual([false, ['no_coverage_on_file']]);
    const ok = await createPatient(r.h, 'Synthetic Visit Ready');
    const cov = await coverage(ok, 'syn-payer-wf-visit');
    const p1 = r.h.ok<{
      data: {
        ready: boolean;
        paymentAssurance: string;
        coverages: { coverageRef: string; freshness: string | null }[];
      };
    }>(await r.h.call('a1', 'GET', `/v1/rcm/patients/${ok}/visit-preparation?serviceDate=${today()}`)).data;
    expect([
      p1.ready,
      p1.paymentAssurance,
      p1.coverages.map((c) => [c.coverageRef, c.freshness]),
    ]).toStrictEqual([true, 'none', [[cov, 'current']]]);
    expect(
      (await r.h.call('b1', 'GET', `/v1/rcm/patients/${ok}/visit-preparation?serviceDate=${today()}`))
        .statusCode,
    ).toBe(404);
    expect(
      (await r.h.call('a5', 'GET', `/v1/rcm/patients/${ok}/visit-preparation?serviceDate=${today()}`))
        .statusCode,
    ).toBe(403);
  });
});

describe('CL-04 attachment package', () => {
  it('binds the version, its references and digests; an altered original refuses the dispatch', async () => {
    const c = await claim('Synthetic Package', 'syn-payer-wf-pkg');
    await svc.attachToClaim(
      a1(),
      c.claimRef,
      env('rcm.claims.attach', {
        expectedVersion: 1,
        objectRef: 'syn-img-wf-bitewing-1',
        kind: 'radiograph',
      }),
    );
    const invalid = await svc.validateClaim(
      a1(),
      c.claimRef,
      env('rcm.claims.validate', { expectedVersion: 2 }),
    );
    expect(invalid.data.outcome).toBe('invalid');
    const pkg = (items: { objectRef: string; digest: string }[]) =>
      svc.packageClaimAttachments(
        a1(),
        c.claimRef,
        env('rcm.claims.packageAttachments', { expectedVersion: 3, items }),
      );
    expect(await refusal(pkg([{ objectRef: 'syn-img-wf-bitewing-1', digest: 'a'.repeat(64) }]))).toBe(
      'validation_failed:attachment_digest_mismatch',
    );
    expect(
      await refusal(pkg([{ objectRef: 'syn-img-wf-other', digest: objects.digestFor('syn-img-wf-other') }])),
    ).toBe('validation_failed:package_items_mismatch');
    expect(
      (
        await pkg([
          { objectRef: 'syn-img-wf-bitewing-1', digest: objects.digestFor('syn-img-wf-bitewing-1') },
        ])
      ).data.outcome,
    ).toBe('packaged');
    expect(
      (await svc.validateClaim(a1(), c.claimRef, env('rcm.claims.validate', { expectedVersion: 4 }))).data
        .outcome,
    ).toBe('valid');
    objects.alter('syn-img-wf-bitewing-1');
    expect(
      await refusal(
        svc.submitClaim(
          a1(),
          c.claimRef,
          env('rcm.claims.submit', { expectedVersion: 5, authorization: { mode: 'explicit' } }),
        ),
      ),
    ).toBe('conflict:attachment_package_stale');
    const { rows } = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.rcm_claim_submissions WHERE claim_id = $1',
      [c.claimRef],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('CL-08 durable timers, owned exceptions and bounded escalation', () => {
  it('the outbox worker fires the payer follow-up and escalates its exception once, deduplicated', async () => {
    const c = await claim('Synthetic Silent Payer', 'syn-payer-noresponse-wf');
    const wp = await policy('syn-payer-noresponse-wf', 0, 0, 1);
    const wf = (
      await svc.startClaimWorkflow(
        a1(),
        env('rcm.workflows.start', {
          claimRef: c.claimRef,
          workflowPolicyRef: wp,
          submissionPolicyRef: await submissionPolicy(),
        }),
      )
    ).data.workflowRef;
    await svc.advanceClaimWorkflow(engine(), wf);
    await svc.advanceClaimWorkflow(engine(), wf);
    expect((await svc.getClaimWorkflow(a1(), wf)).claims[0]?.state).toBe('transmitted');
    const worker = createWorker({
      workerPrincipalId: SVC_BILLING_WORKER,
      withTenantTransaction: createTenantTransactionRunner(db.app),
      authorize: createAuthorize(createMembershipSource(db.app)),
      memberships: createMembershipSource(db.app),
      attempts: createSecurityAttemptSink(db.sink),
      backoffSeconds: () => 0,
      claimWorkflows: svc,
    });
    const adapter = new FakeProvider();
    for (let round = 0; round < 3; round += 1)
      for (let i = 0; i < 30; i += 1) if ((await worker.runOnce(T_ALPHA, adapter)).length === 0) break;
    const v = await svc.getClaimWorkflow(a1(), wf);
    const follow = v.exceptions.filter((x) => x.issueKey.startsWith('payer_follow_up:'));
    expect(follow.map((x) => [x.state, x.owner, x.owedBy, x.escalationLevel])).toStrictEqual([
      ['open', 'billing', 'payer', 1],
    ]);
    expect(v.timers.map((t) => [t.kind, t.level, t.firedOutcome]).sort()).toStrictEqual(
      [
        ['exception_escalation', 1, 'escalated_level_1'],
        ['payer_follow_up', 0, 'fired'],
      ].sort(),
    );
    // A re-delivered timer (REST twin under a service principal) records nothing twice.
    const timer = v.timers[0]?.timerRef as string;
    const again = r.h.ok<{ data: { changes: number } }>(
      await r.h.call('svcA1', 'POST', `/v1/rcm/workflow-timers/${timer}/fire`, {}),
    );
    expect(again.data.changes).toBe(0);
    const { rows } = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.rcm_claim_workflow_timer_firings f
       JOIN cuspatlas.rcm_claim_workflow_timers t ON t.id = f.timer_id WHERE t.workflow_id = $1`,
      [wf],
    );
    expect(rows[0].n).toBe(2);
    expect((await r.h.call('a1', 'POST', `/v1/rcm/workflow-timers/${timer}/fire`, {})).statusCode).toBe(403);
  });

  it('a standing policy revoked mid-job stops dispatch after bounded attempts and surfaces one owned exception', async () => {
    const c = await claim('Synthetic Revoked Policy', 'syn-payer-wf-revoke');
    const sp = await submissionPolicy();
    const wf = (
      await svc.startClaimWorkflow(
        a1(),
        env('rcm.workflows.start', { claimRef: c.claimRef, submissionPolicyRef: sp }),
      )
    ).data.workflowRef;
    await svc.advanceClaimWorkflow(engine(), wf);
    await svc.revokeSubmissionPolicy(
      a1(),
      sp,
      env('rcm.submissionPolicies.revoke', { reasonCode: 'practice_request' }),
    );
    for (let i = 0; i < 5; i += 1) await svc.advanceClaimWorkflow(engine(), wf);
    const v = await svc.getClaimWorkflow(a1(), wf);
    expect(
      v.steps.filter((s) => s.step === 'automation' && s.outcome === 'submit_refused_policy_revoked'),
    ).toHaveLength(3);
    expect(
      v.exceptions.filter((x) => x.state === 'open').map((x) => [x.issueKey.split(':')[0], x.owner]),
    ).toStrictEqual([['submit_claim', 'billing']]);
    const { rows } = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.rcm_claim_submissions WHERE claim_id = $1',
      [c.claimRef],
    );
    expect(rows[0].n).toBe(0);
    // A person approves explicitly; the exception resolves on the next observation.
    await svc.submitClaim(
      a1(),
      c.claimRef,
      env('rcm.claims.submit', {
        expectedVersion: await version(c.claimRef),
        authorization: { mode: 'explicit' },
      }),
    );
    await svc.advanceClaimWorkflow(engine(), wf);
    const after = await svc.getClaimWorkflow(a1(), wf);
    expect(
      after.exceptions.filter((x) => x.state === 'open').map((x) => x.issueKey.split(':')[0]),
    ).toStrictEqual([]);
    expect(after.steps.find((s) => s.step === 'dispatch')?.authority).toMatchObject({
      kind: 'explicit_approval',
      approvedBy: USER_A1,
    });
  });

  it('denials: another tenant, a member without scope, a service closing, a secondary as a lineage root', async () => {
    const c = await claim('Synthetic Workflow Denials', 'syn-payer-wf-deny');
    const wf = (await svc.startClaimWorkflow(a1(), env('rcm.workflows.start', { claimRef: c.claimRef }))).data
      .workflowRef;
    expect((await r.h.call('b1', 'GET', `/v1/rcm/workflows/${wf}`)).statusCode).toBe(404);
    expect((await r.h.call('a5', 'GET', `/v1/rcm/workflows/${wf}`)).statusCode).toBe(403);
    expect(await refusal(svc.advanceClaimWorkflow(ctxFor(T_BETA, USER_B1, 'human', BILLING_ALL), wf))).toBe(
      'not_found:resource_hidden_or_missing',
    );
    expect(
      await refusal(svc.closeClaimWorkflow(engine(), wf, env('rcm.workflows.close', { expectedVersion: 1 }))),
    ).toBe('forbidden:principal_kind_denied');
    expect(
      await refusal(
        svc.startClaimWorkflow(
          ctxFor(T_BETA, USER_B1, 'human', BILLING_ALL),
          env('rcm.workflows.start', { claimRef: c.claimRef }),
        ),
      ),
    ).toBe('not_found:resource_hidden_or_missing');
  });
});
