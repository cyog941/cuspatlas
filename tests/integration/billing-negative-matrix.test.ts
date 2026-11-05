import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BILLING_OPS, ROUTES } from '@cuspatlas/api';
import { createFakeClearinghouse } from '@cuspatlas/domain';
import { TOOLS } from '@cuspatlas/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatient, type Who } from './support/appointment-fixtures';
import { BILLING_ALL, billingTables, usd } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, T_ALPHA, USER_A1, USER_A3 } from './support/fixtures';
import { openRcmHarness, type RcmHarness, today } from './support/rcm-fixtures';

/**
 * B10 billing negative matrix: every operation of the billing operation table (B6, B7, B8, B9, the
 * C14 consumer, the remittance resolution and the closed-loop workflow) attempted cross-tenant, with a
 * revoked membership, with a downgraded role, each through REST and MCP under the runtime role. The B1-B5
 * operations are rows of the shared harness (tests/integration/negative-harness.test.ts); the coverage
 * case below fails when any billing or rcm route is in neither. A refusal changes no alpha row, records
 * its attempt and is the same on both surfaces; another tenant learns nothing about alpha.
 */
let db: TestDatabase;
let r: RcmHarness;
const fake = createFakeClearinghouse();
let svc: ReturnType<RcmHarness['service']>;
type F = Record<string, string>;
let f: F;
const env = (operation: string, payload: unknown) => ({ operation, idempotencyKey: randomUUID(), payload });
const a1 = () => ctxFor(T_ALPHA, USER_A1, 'human', [...BILLING_ALL, 'patients.read', 'patients.write']);

/** Valid bodies (or queries) so a cross-tenant attempt reaches the lookup that hides alpha. */
const BODIES: Record<string, (f: F) => Record<string, unknown>> = {
  'billing.feeSchedules.publish': () => ({
    scheduleRef: 'syn-fee-negative',
    purpose: 'practice',
    effectiveFrom: '2026-01-01',
    items: [{ codeRef: 'SYN-NEG-100', fee: usd(1000) }],
  }),
  'billing.fees.resolve': (x) => ({
    codeRef: 'SYN-NEG-100',
    serviceDate: today(),
    coverageRef: x.coverage as string,
  }),
  'billing.adjustments.post': () => ({
    kind: 'courtesy',
    responsibility: 'patient',
    amount: usd(100),
    reasonCode: 'courtesy_discount',
  }),
  'billing.adjustments.decide': () => ({ decision: 'approved' }),
  'billing.reports.receivables': () => ({}),
  'rcm.claims.prepare': (x) => ({
    patientRef: x.patient as string,
    coverageRef: x.coverage as string,
    procedureRefs: [x.procedure as string],
  }),
  'rcm.claims.worklist': () => ({}),
  'rcm.claims.validate': () => ({ expectedVersion: 1 }),
  'rcm.claims.attach': () => ({ expectedVersion: 1, objectRef: 'syn-img-negative', kind: 'radiograph' }),
  'rcm.claims.replace': () => ({ expectedVersion: 1, reasonCode: 'negative_probe' }),
  'rcm.claims.submit': () => ({ expectedVersion: 1, authorization: { mode: 'explicit' } }),
  'rcm.claims.prepareSecondary': (x) => ({ coverageRef: x.coverage as string }),
  'rcm.claims.packageAttachments': () => ({
    expectedVersion: 1,
    items: [{ objectRef: 'syn-img-negative', digest: 'a'.repeat(64) }],
  }),
  'rcm.appeals.draft': (x) => ({ basisCode: 'medical_necessity', denialEventRef: x.denialEvent as string }),
  'rcm.appeals.review': () => ({ decision: 'reject' }),
  'rcm.submissionPolicies.create': () => ({ maxBilled: usd(1000) }),
  'rcm.submissionPolicies.revoke': () => ({ reasonCode: 'negative_probe' }),
  'rcm.remittances.ingest': (x) => ({ remittanceRef: x.eraRef as string }),
  'rcm.remittances.settle': () => ({ settlementRef: 'syn-eft-negative', amount: usd(1000) }),
  'rcm.remittances.reverse': () => ({ reasonCode: 'negative_probe' }),
  'rcm.remittances.resolveLine': () => ({ action: 'route_to_appeal', reasonCode: 'negative_probe' }),
  'rcm.remittances.decideResolution': () => ({ decision: 'rejected' }),
  'rcm.workflowPolicies.publish': () => ({
    acknowledgementDueMinutes: 1,
    followUpMinutes: 1,
    exceptionDueMinutes: 1,
    maxEscalations: 1,
    writeOffLimit: usd(0),
  }),
  'rcm.visits.prepare': () => ({ serviceDate: today() }),
  'rcm.workflows.start': (x) => ({ claimRef: x.claim as string }),
  'rcm.workflows.close': () => ({ expectedVersion: 1 }),
  'billing.export': () => ({}),
};
/** Path parameter -> fixture key. */
const PARAMS: Record<string, string> = {
  procedureRef: 'procedure',
  chargeRef: 'charge',
  requestRef: 'adjustmentRequest',
  claimRef: 'claim',
  appealRef: 'appeal',
  policyRef: 'submissionPolicy',
  remittanceRef: 'remittance',
  resolutionRef: 'resolution',
  workflowRef: 'workflow',
  timerRef: 'timer',
  patientRef: 'patient',
};
/** Operations whose cross-tenant attempt targets no alpha record (they act in the caller's tenant). */
const OWN_TENANT = new Set([
  'billing.feeSchedules.publish',
  'billing.reports.receivables',
  'rcm.claims.worklist',
  'rcm.submissionPolicies.create',
  'rcm.remittances.ingest',
  'rcm.workflowPolicies.publish',
  'billing.export',
]);
/**
 * Operations whose cross-tenant attempt is refused by validation of a reference in the body (another
 * tenant's coverage reads as unknown): the outcome must equal the one for a random reference.
 */
const SAME_AS_MISSING = new Set(['billing.fees.resolve']);
const SERVICE_ONLY = new Set(['billing.procedures.consume', 'rcm.workflows.fireTimer']);
const ops = BILLING_OPS;
const unkeyed = (op: (typeof ops)[number]) => op.method === 'post' && op.unkeyed === true;

/** MCP call that also reports a protocol-level refusal (revoked membership) with its status. */
async function mcpCall(who: Who, tool: string, args: Record<string, unknown>) {
  try {
    return await r.h.mcp(who, tool, args);
  } catch (e) {
    const err = e as { code?: unknown; message?: string };
    const message = String(err.message);
    const start = message.indexOf('{');
    if (start < 0) throw e;
    const body = JSON.parse(message.slice(start)) as Record<string, unknown>;
    const status = typeof err.code === 'number' ? err.code : body.code === 'forbidden' ? 403 : 401;
    return { status, code: typeof body.code === 'string' ? body.code : null, body };
  }
}

function call(op: (typeof ops)[number], over: Partial<F> = {}) {
  const fx = { ...f, ...over };
  const params = Object.fromEntries(
    [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => [
      m[1] as string,
      m[1] === 'lineNo' ? '1' : (fx[PARAMS[m[1] as string] as string] as string),
    ]),
  );
  const url = op.path.replace(/\{(\w+)\}/g, (_m, p: string) => params[p] as string);
  const body = (BODIES[op.operationId] ?? (() => ({})))(fx as F);
  const query =
    op.method === 'get' && Object.keys(body).length > 0
      ? `?${new URLSearchParams(body as Record<string, string>)}`
      : '';
  return { params, url: `${url}${query}`, body };
}

/** Digest of every alpha billing and rcm row plus alpha audit and outbox counts. */
async function alphaState(): Promise<string> {
  const parts: string[] = [];
  for (const t of await billingTables(db)) {
    const { rows } = await db.admin.query(
      `SELECT coalesce(md5(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text)), '') AS d FROM cuspatlas.${t} t
       WHERE t.tenant_id = $1`,
      [T_ALPHA],
    );
    parts.push(`${t}:${rows[0].d}`);
  }
  for (const t of ['audit_events', 'outbox_events', 'command_idempotency']) {
    const { rows } = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.${t} WHERE tenant_id = $1`,
      [T_ALPHA],
    );
    parts.push(`${t}:${rows[0].n}`);
  }
  return parts.join(',');
}
const reasons = async (correlationId: string | null | undefined) =>
  !correlationId
    ? []
    : (
        await db.admin.query(
          'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
          [correlationId],
        )
      ).rows.map((x) => x.reason_code as string);

beforeAll(async () => {
  db = await openTestDatabase('billing_negative_matrix');
  r = await openRcmHarness(db, { mcp: true });
  svc = r.service({ claims: fake });
  await r.publishFee('syn-fee-standard', [['SYN-NEG-100', 20000]]);
  await db.admin.query(
    "UPDATE cuspatlas.memberships SET scopes = scopes || '{billing.correct}'::text[] WHERE principal_id = $1",
    [USER_A3],
  );
  const coverage = async (patient: string, payerRef: string) => {
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
    r.h.ok(
      await r.h.call('a1', 'POST', `/v1/rcm/coverages/${ref}/eligibility`, {
        source: 'fake_adapter',
        serviceDate: today(),
      }),
      201,
    );
    return ref;
  };
  const claimFor = async (given: string, payerRef: string) => {
    const patient = await createPatient(r.h, given);
    const cov = await coverage(patient, payerRef);
    const proc = await r.render(await r.encounter(patient), 'SYN-NEG-100');
    const charge = r.h.ok<{ data: { chargeRef: string } }>(await r.consume(proc)).data.chargeRef;
    const claim = (
      await svc.prepareClaim(
        a1(),
        env('rcm.claims.prepare', { patientRef: patient, coverageRef: cov, procedureRefs: [proc] }),
      )
    ).data.claimRef;
    await svc.validateClaim(a1(), claim, env('rcm.claims.validate', { expectedVersion: 1 }));
    await svc.submitClaim(
      a1(),
      claim,
      env('rcm.claims.submit', { expectedVersion: 2, authorization: { mode: 'explicit' } }),
    );
    return { patient, cov, proc, charge, claim };
  };
  const denied = await claimFor('Synthetic Negative Denied', 'syn-payer-deny-neg');
  await svc.pollClaim(a1(), denied.claim);
  const { rows: ev } = await db.admin.query(
    "SELECT id FROM cuspatlas.rcm_claim_events WHERE claim_id = $1 AND kind = 'adjudicated_denied'",
    [denied.claim],
  );
  const appeal = (
    await svc.draftAppeal(
      a1(),
      denied.claim,
      env('rcm.appeals.draft', { basisCode: 'coding_review', denialEventRef: ev[0].id }),
    )
  ).data.appealRef;
  const paid = await claimFor('Synthetic Negative Matrix', 'syn-payer-neg');
  const eraRef = `syn-era-neg-${Date.now().toString(36)}`;
  fake.stageRemittance({
    remittanceRef: eraRef,
    payerRef: 'syn-payer-neg',
    currency: 'USD',
    totalPaidMinor: 1000,
    lines: [
      {
        lineNo: 1,
        claimRef: paid.claim,
        claimLineNo: 1,
        paidMinor: 1000,
        contractualMinor: 0,
        patientResponsibilityMinor: 0,
      },
    ],
  });
  const remittance = (
    await svc.ingestRemittance(a1(), env('rcm.remittances.ingest', { remittanceRef: eraRef }))
  ).data.remittanceRef;
  const resolution = (
    await svc.resolveRemittanceLine(
      a1(),
      remittance,
      '1',
      env('rcm.remittances.resolveLine', { action: 'post_with_adjustment', reasonCode: 'staff_review' }),
    )
  ).data.resolutionRef;
  const adjustmentRequest = r.h.ok<{ data: { requestRef: string } }>(
    await r.h.call('a1', 'POST', `/v1/billing/charges/${paid.charge}/adjustments`, {
      kind: 'courtesy',
      responsibility: 'patient',
      amount: usd(100),
      reasonCode: 'courtesy_discount',
    }),
    201,
  ).data.requestRef;
  const submissionPolicy = (
    await svc.createSubmissionPolicy(a1(), env('rcm.submissionPolicies.create', { maxBilled: usd(100000) }))
  ).data.policyRef;
  const workflowPolicy = (
    await svc.publishWorkflowPolicy(
      a1(),
      env('rcm.workflowPolicies.publish', {
        payerRef: 'syn-payer-neg',
        acknowledgementDueMinutes: 0,
        followUpMinutes: 0,
        exceptionDueMinutes: 1440,
        maxEscalations: 1,
        writeOffLimit: usd(0),
      }),
    )
  ).data.policyRef;
  const workflow = (
    await svc.startClaimWorkflow(
      a1(),
      env('rcm.workflows.start', { claimRef: paid.claim, workflowPolicyRef: workflowPolicy }),
    )
  ).data.workflowRef;
  await svc.advanceClaimWorkflow(a1(), workflow);
  const timer = (await svc.getClaimWorkflow(a1(), workflow)).timers[0]?.timerRef as string;
  f = {
    patient: paid.patient,
    coverage: paid.cov,
    procedure: paid.proc,
    charge: paid.charge,
    claim: paid.claim,
    denialEvent: ev[0].id,
    appeal,
    eraRef,
    remittance,
    resolution,
    adjustmentRequest,
    submissionPolicy,
    workflow,
    timer,
  };
  expect(Object.values(f).every((v) => typeof v === 'string' && v.length > 0)).toBe(true);
});

afterAll(async () => {
  await r?.h.close();
  await db?.close();
});

type Dimension = 'crossTenant' | 'revoked' | 'downgraded';
const matrix: string[] = [];

describe('B10 billing negative matrix (every operation-table row, every dimension, REST and MCP)', () => {
  it('every billing and rcm route is a row here or in the shared harness', () => {
    const shared = readFileSync(resolve(import.meta.dirname, 'negative-harness.test.ts'), 'utf8');
    const inShared = new Set(
      [...shared.matchAll(/operation: '((?:billing|rcm)\.[A-Za-z.]+)'/g)].map((m) => m[1]),
    );
    for (const [, operation] of shared.matchAll(/'((?:billing|rcm)\.plans\.[a-z]+)',\s*'billing_plans_/g))
      inShared.add(operation);
    const here = new Set(ops.map((o) => o.operationId as string));
    const missing = ROUTES.filter(
      (x) => x.operationId.startsWith('billing.') || x.operationId.startsWith('rcm.'),
    )
      .map((x) => x.operationId)
      .filter((op) => !here.has(op) && !inShared.has(op));
    expect(missing).toStrictEqual([]);
    for (const op of ops)
      expect([op.operationId, TOOLS.some((t) => t.name === op.tool)]).toStrictEqual([op.operationId, true]);
  });

  const cases = ops.flatMap((op) =>
    (['crossTenant', 'revoked', 'downgraded'] as Dimension[]).map((d) => [op.operationId, d, op] as const),
  );
  it.each(cases)('%s %s', async (_id, d, op) => {
    const c = call(op);
    const who: Who =
      d === 'revoked'
        ? 'a2'
        : d === 'downgraded'
          ? op.method === 'get'
            ? 'a5'
            : 'a4'
          : SERVICE_ONLY.has(op.operationId)
            ? 'svcB1'
            : 'b1';
    const before = await alphaState();
    const rest = await r.h.call(
      who,
      op.method === 'get' ? 'GET' : 'POST',
      c.url,
      op.method === 'get' ? undefined : unkeyed(op) ? {} : c.body,
      op.method === 'post' && !unkeyed(op) ? randomUUID() : null,
    );
    const mcp = await mcpCall(who, op.tool, {
      ...c.params,
      ...(unkeyed(op) ? {} : c.body),
      ...(op.method === 'post' && !unkeyed(op) ? { idempotencyKey: randomUUID() } : {}),
    });
    const restReasons = await reasons(rest.headers['x-correlation-id'] as string);
    const mcpReasons = await reasons(mcp.body.correlationId as string | undefined);
    const raw = `${rest.body}${JSON.stringify(mcp.body)}`;
    if (d === 'crossTenant' && SAME_AS_MISSING.has(op.operationId)) {
      const missing = call(op, { coverage: randomUUID() });
      const probe = await r.h.call(who, 'GET', missing.url);
      expect([rest.statusCode, rest.json().code]).toStrictEqual([probe.statusCode, probe.json().code]);
      expect([mcp.status, mcp.code]).toStrictEqual([probe.statusCode, probe.json().code]);
      for (const ref of Object.values(f).filter((v) => !c.url.includes(v))) expect(raw).not.toContain(ref);
    } else if (d === 'crossTenant' && OWN_TENANT.has(op.operationId)) {
      // Acts in the caller's own tenant: never an alpha reference, never an alpha change.
      for (const ref of Object.values(f)) expect(raw).not.toContain(ref);
      expect(rest.statusCode).toBeLessThan(500);
      expect(mcp.status).toBeLessThan(500);
    } else {
      const want =
        d === 'crossTenant'
          ? [404, 'not_found', 'resource_hidden_or_missing']
          : d === 'revoked'
            ? [403, 'forbidden', 'membership_inactive']
            : [
                403,
                'forbidden',
                restReasons[0] === 'principal_kind_denied' ? 'principal_kind_denied' : 'scope_missing',
              ];
      expect(['REST', rest.statusCode, rest.json().code, restReasons]).toStrictEqual([
        'REST',
        want[0],
        want[1],
        [want[2]],
      ]);
      expect(['MCP', mcp.status, mcp.code, mcpReasons]).toStrictEqual(['MCP', want[0], want[1], [want[2]]]);
      for (const ref of Object.values(f).filter((v) => !c.url.includes(v))) expect(raw).not.toContain(ref);
    }
    expect(await alphaState()).toBe(before);
    matrix.push(
      `${op.operationId.padEnd(36)} ${d.padEnd(11)} REST ${rest.statusCode}/${restReasons[0] ?? '-'}  MCP ${mcp.status}/${mcpReasons[0] ?? '-'}`,
    );
  });

  afterAll(() => {
    process.stdout.write(
      `\nB NEGATIVE MATRIX (${matrix.length} cases over ${ops.length} operations)\n${matrix.join('\n')}\n`,
    );
  });
});
