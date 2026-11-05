import { randomUUID } from 'node:crypto';
import {
  validateConsentCommandResult,
  validateConsentList,
  validateConsentRead,
  validateConsentTemplateCommandResult,
} from '@cuspatlas/contracts';
import { createTenantTransactionRunner } from '@cuspatlas/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  leakTables,
  mergePatients,
  openAppointmentHarness,
  T_ALPHA,
  USER_A1,
} from './support/appointment-fixtures';
import { seedClinicalScopes } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { seedPracticeFees } from './support/fee-fixtures';
import { ctxFor, USER_A4 } from './support/fixtures';
import { MARKER } from './support/marker';
import { patientBody } from './support/patient-fixtures';

/**
 * C13: consent capture (synthetic engineering implementation of C-D6, recommended-pending-approval).
 * Treatment consent only: E's messaging consent and suppression are a different concept and are
 * never read or written here. Signer authority is evaluated at capture through S5 (scope consent).
 * Every denial runs under the runtime role.
 */
let db: TestDatabase;
let h: AppointmentHarness;
const CONSENTS = '/v1/clinical/consents';
const PLANS = '/v1/clinical/treatment-plans';
const MINOR = { known: true, value: '2016-05-05', precision: 'day' };
const DIGEST = `sha256:${'a'.repeat(64)}`;
const DIGEST_2 = `sha256:${'b'.repeat(64)}`;

beforeAll(async () => {
  db = await openTestDatabase('clinical_consents');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedClinicalScopes(db.admin);
  // C12 -> B9: the supplied line fee must equal the server practice fee.
  await seedPracticeFees(db, [['SYN-PROC-300', 5000]]);
  await db.admin.query(
    `INSERT INTO cuspatlas.clinical_consent_method_policies (tenant_id, method, witness_required)
     VALUES ($1, 'verbal_attested', true), ($1, 'in_person', false), ($1, 'paper', false), ($1, 'portal', false)
     ON CONFLICT (tenant_id, method) DO UPDATE SET witness_required = EXCLUDED.witness_required`,
    [T_ALPHA],
  );
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

type Consent = {
  consentRef: string;
  patientRef: string;
  sourcePatientRef: string;
  scope: string;
  planVersionRef: string | null;
  planItemRef: string | null;
  acceptanceRef: string | null;
  method: string;
  templateDigest: string;
  templateStatus: string;
  evidence: { artifactRef: string; digest: string } | null;
  signer: { kind: string; personRef: string; basis: string; relationshipRefs: string[] };
  witnessRef: string | null;
  version: number;
  state: string;
  withdrawal: { reasonCode: string; effectiveAt: string; signer: { kind: string } } | null;
};

async function person(given: string, birthDate?: object): Promise<string> {
  const res = await h.call('a1', 'POST', '/v1/patients', patientBody(given, birthDate ? { birthDate } : {}));
  expect(res.statusCode).toBe(201);
  return res.json().data.patientRef;
}
async function relate(subject: string, counterparty: string, kind: string, scopes: string[]) {
  const res = await h.call('a1', 'POST', `/v1/patients/${subject}/relationships`, {
    counterpartyRef: counterparty,
    kind,
    scopes,
    ...(kind === 'proxy' ? { effectiveUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() } : {}),
  });
  expect(res.statusCode).toBe(201);
  return res.json().data.relationshipRef as string;
}
const body = (patientRef: string, extra: Record<string, unknown> = {}) => ({
  patientRef,
  scope: 'general_treatment',
  method: 'in_person',
  templateRef: 'synthetic-consent-general',
  templateDigest: DIGEST,
  attestationCode: 'signed_in_person',
  signer: { kind: 'patient' },
  ...extra,
});
const capture = (b: Record<string, unknown>, who = 'a1', key = randomUUID()) =>
  h.call(who, 'POST', CONSENTS, b, key);
const okC = (res: Awaited<ReturnType<AppointmentHarness['call']>>, status = 201) => {
  const json = h.ok<{ data: Consent; replayed: boolean }>(res, status);
  expect(validateConsentCommandResult(json)).toBe(true);
  return json;
};
const withdraw = (consentRef: string, b: Record<string, unknown>) =>
  h.call('a1', 'POST', `${CONSENTS}/${consentRef}/withdrawal`, b);
const reason = (res: Awaited<ReturnType<AppointmentHarness['call']>>) => [
  res.statusCode,
  res.json().detail?.reason ?? res.json().detail?.violations?.[0]?.rule ?? res.json().code,
];
async function attempts(res: Awaited<ReturnType<AppointmentHarness['call']>>): Promise<string[]> {
  const { rows } = await db.admin.query(
    'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
    [res.headers['x-correlation-id']],
  );
  return rows.map((r) => r.reason_code);
}
async function list(patientRef: string, query = '') {
  const json = h.ok<{ data: Consent[]; asOf: string }>(
    await h.call('a1', 'GET', `/v1/clinical/patients/${patientRef}/consents${query}`),
  );
  expect(validateConsentList(json)).toBe(true);
  return json;
}

/** A plan with one fee-bearing item, an estimate and (optionally) an acceptance. */
async function acceptedPlan(patientRef: string, accept = true) {
  const plan = h.ok<{ data: { plan: { planRef: string; headVersionRef: string } } }>(
    await h.call('a1', 'POST', PLANS, { patientRef }, randomUUID()),
    201,
  ).data.plan;
  const v = plan.headVersionRef;
  const d = h.ok<{ data: { targetRef: string } }>(
    await h.call('a1', 'POST', `${PLANS}/versions/${v}/details`, {
      expectedRevision: 1,
      scope: 'whole_mouth',
    }),
    201,
  ).data.targetRef;
  const item = h.ok<{ data: { targetRef: string } }>(
    await h.call('a1', 'POST', `${PLANS}/details/${d}/items`, {
      expectedRevision: 2,
      procedureCodeRef: 'SYN-PROC-300',
      sequence: 1,
      feeScheduleRef: 'synthetic-fee-300',
    }),
    201,
  ).data.targetRef;
  const estimate = h.ok<{ data: { estimateRef: string } }>(
    await h.call('a1', 'POST', `${PLANS}/versions/${v}/estimates`, {
      lines: [{ planItemRef: item, fee: { currency: 'USD', minor: 5000 } }],
    }),
    201,
  ).data.estimateRef;
  if (accept) {
    h.ok(await h.call('a1', 'POST', `/v1/clinical/estimates/${estimate}/presentation`, {}));
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/estimates/${estimate}/acceptance`, {
        expectedRevision: 3,
        scope: 'full',
      }),
      201,
    );
  }
  return { planRef: plan.planRef, versionRef: v, item, estimate, revision: accept ? 4 : 3 };
}

describe('C13 acceptance cases', () => {
  it('1. a guardian with a valid consent grant consents for a minor; after expiry the same attempt is refused', async () => {
    const minor = await person('Synthetic Consent Minor', MINOR);
    const guardian = await person('Synthetic Consent Guardian');
    const rel = await relate(minor, guardian, 'guardian', ['consent']);
    const c = okC(
      await capture(body(minor, { signer: { kind: 'related_person', personRef: guardian } })),
    ).data;
    expect(c.signer).toMatchObject({
      kind: 'related_person',
      personRef: guardian,
      basis: 'relationship_consent_scope',
      relationshipRefs: [rel],
    });
    // The minor cannot consent alone.
    const alone = await capture(body(minor));
    expect([alone.statusCode, alone.json().detail?.reason]).toStrictEqual([403, 'consent_signer_minor']);
    expect(await attempts(alone)).toStrictEqual(['consent_signer_minor']);
    // A relationship without the consent scope does not grant it.
    const other = await person('Synthetic Consent Scheduler');
    await relate(minor, other, 'guardian', ['scheduling']);
    const noScope = await capture(body(minor, { signer: { kind: 'related_person', personRef: other } }));
    expect([noScope.statusCode, noScope.json().detail?.reason]).toStrictEqual([
      403,
      'relationship_scope_missing',
    ]);
    // Time passes: the grant ends; authority is rechecked, never inherited from the earlier consent.
    await db.admin.query(
      `UPDATE cuspatlas.patient_relationships SET effective_from = now() - interval '2 days',
         effective_until = now() - interval '1 second', version = version + 1 WHERE id = $1`,
      [rel],
    );
    const expired = await capture(body(minor, { signer: { kind: 'related_person', personRef: guardian } }));
    expect([expired.statusCode, expired.json().detail?.reason]).toStrictEqual([403, 'relationship_expired']);
    expect(await attempts(expired)).toStrictEqual(['relationship_expired']);
    // An adult consents for themself.
    const adult = await person('Synthetic Consent Adult');
    expect(okC(await capture(body(adult))).data.signer).toMatchObject({
      kind: 'patient',
      basis: 'self_adult',
    });
  });

  it('2. consent binds a specific plan version; a newer version does not inherit it', async () => {
    const p = await person('Synthetic Consent Plan');
    const a = await acceptedPlan(p);
    const c = okC(
      await capture(
        body(p, {
          scope: 'treatment_plan',
          planVersionRef: a.versionRef,
          templateRef: 'synthetic-consent-plan',
        }),
      ),
    ).data;
    expect([c.planVersionRef, c.acceptanceRef === null]).toStrictEqual([a.versionRef, false]);
    const est = h.ok<{ data: { acceptance: { consent: { status: string; consentRefs: string[] } } } }>(
      await h.call('a1', 'GET', `/v1/clinical/estimates/${a.estimate}`),
    );
    expect(est.data.acceptance.consent).toStrictEqual({ status: 'bound', consentRefs: [c.consentRef] });
    // A procedure-scoped consent names the item of that version.
    const proc = okC(
      await capture(body(p, { scope: 'procedure', planVersionRef: a.versionRef, planItemRef: a.item })),
    ).data;
    expect(proc.planItemRef).toBe(a.item);
    // Superseding: the new version starts with no consent; the old one cannot take a new consent.
    const next = h.ok<{ data: { targetRef: string } }>(
      await h.call('a1', 'POST', `${PLANS}/versions/${a.versionRef}/supersede`, {
        expectedRevision: a.revision,
        reasonCode: 'treatment_changed',
      }),
      201,
    ).data.targetRef;
    const late = await capture(body(p, { scope: 'treatment_plan', planVersionRef: a.versionRef }));
    expect([late.statusCode, late.json().detail]).toStrictEqual([
      409,
      { reason: 'plan_version_superseded', blockingRefs: [{ kind: 'planVersion', ref: next }] },
    ]);
    const forNext = await list(p, `?planVersionRef=${next}`);
    expect(forNext.data).toStrictEqual([]);
    const forOld = await list(p, `?planVersionRef=${a.versionRef}`);
    expect(forOld.data.map((x) => x.consentRef).sort()).toStrictEqual([c.consentRef, proc.consentRef].sort());
    // An item of another version is refused.
    const b = await acceptedPlan(p, false);
    const wrong = await capture(
      body(p, { scope: 'procedure', planVersionRef: b.versionRef, planItemRef: a.item }),
    );
    expect(reason(wrong)).toStrictEqual([422, 'itemNotInVersion']);
  });

  it('3. withdrawal records an instant and reason; an as-of read reconstructs the state before and after', async () => {
    const p = await person('Synthetic Consent Withdraw');
    const c = okC(await capture(body(p))).data;
    const before = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 15));
    const w = okC(
      await withdraw(c.consentRef, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
        signer: { kind: 'patient' },
      }),
    ).data;
    expect([w.state, w.version, w.withdrawal?.reasonCode, w.withdrawal?.signer.kind]).toStrictEqual([
      'withdrawn',
      2,
      'patient_request',
      'patient',
    ]);
    const at = (await list(p, `?asOf=${encodeURIComponent(before)}`)).data[0];
    expect([at?.state, at?.withdrawal]).toStrictEqual(['active', null]);
    const now = (await list(p)).data[0];
    expect(now?.state).toBe('withdrawn');
    const earlier = (await list(p, `?asOf=${encodeURIComponent('2001-01-01T00:00:00Z')}`)).data;
    expect(earlier).toStrictEqual([]);
    const again = await withdraw(c.consentRef, {
      expectedVersion: 2,
      reasonCode: 'patient_request',
      signer: { kind: 'patient' },
    });
    expect(reason(again)).toStrictEqual([409, 'consent_withdrawn']);
    const read = h.ok<{ data: Consent }>(await h.call('a1', 'GET', `${CONSENTS}/${c.consentRef}`));
    expect(validateConsentRead(read)).toBe(true);
  });

  it('4. another tenant’s patient or a proxy without an active relationship is refused', async () => {
    const p = await person('Synthetic Consent Tenancy');
    const stranger = await person('Synthetic Consent Stranger');
    const cross = await capture(body(p), 'b1');
    expect(cross.statusCode).toBe(404);
    const proxy = await capture(body(p, { signer: { kind: 'related_person', personRef: stranger } }));
    expect([proxy.statusCode, proxy.json().detail?.reason]).toStrictEqual([403, 'relationship_missing']);
    expect(await attempts(proxy)).toStrictEqual(['relationship_missing']);
    const c = okC(await capture(body(p))).data;
    expect((await h.call('b1', 'GET', `${CONSENTS}/${c.consentRef}`)).statusCode).toBe(404);
    expect((await h.call('b1', 'GET', `/v1/clinical/patients/${p}/consents`)).statusCode).toBe(404);
    expect(
      (
        await h.call('b1', 'POST', `${CONSENTS}/${c.consentRef}/withdrawal`, {
          expectedVersion: 1,
          reasonCode: 'patient_request',
          signer: { kind: 'patient' },
        })
      ).statusCode,
    ).toBe(404);
    expect((await capture({ ...body(p), tenantId: T_ALPHA })).statusCode).toBe(400);
  });

  it('5. a paper capture records an artifact reference and digest only; a signature image is refused', async () => {
    const p = await person('Synthetic Consent Paper');
    const missing = await capture(body(p, { method: 'paper' }));
    expect(reason(missing)).toStrictEqual([422, 'evidenceRequired']);
    const evidence = { artifactRef: 'synthetic-scan-001', digest: DIGEST_2 };
    const c = okC(await capture(body(p, { method: 'paper', evidence }))).data;
    expect(c.evidence).toStrictEqual(evidence);
    const image = await capture(
      body(p, { method: 'paper', evidence, signatureImage: 'data:image/png;base64,AAAA' }),
    );
    expect(image.statusCode).toBe(400);
    const { rows } = await db.admin.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'cuspatlas'
         AND table_name LIKE 'clinical_consent%' AND data_type = 'bytea'`,
    );
    expect(rows).toStrictEqual([]);
  });

  it('6. a method that requires a witness fails closed without one', async () => {
    const p = await person('Synthetic Consent Witness');
    const none = await capture(body(p, { method: 'verbal_attested' }));
    expect(reason(none)).toStrictEqual([409, 'witness_required']);
    const c = okC(await capture(body(p, { method: 'verbal_attested', witnessRef: USER_A4 }))).data;
    expect(c.witnessRef).toBe(USER_A4);
  });
});

describe('C13 failure and recovery cases', () => {
  it('1. a duplicate submission replays; concurrent withdrawals leave one linear history', async () => {
    const p = await person('Synthetic Consent Replay');
    const key = randomUUID();
    const first = okC(await capture(body(p), 'a1', key));
    const second = okC(await capture(body(p), 'a1', key));
    expect([second.replayed, second.data.consentRef]).toStrictEqual([true, first.data.consentRef]);
    const n = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.clinical_consents WHERE subject_patient_id = $1',
      [p],
    );
    expect(n.rows[0].n).toBe(1);
    const w = { expectedVersion: 1, reasonCode: 'patient_request', signer: { kind: 'patient' } };
    const results = await Promise.all([
      withdraw(first.data.consentRef, w),
      withdraw(first.data.consentRef, w),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toStrictEqual([201, 409]);
    const rows = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.clinical_consent_withdrawals WHERE consent_id = $1',
      [first.data.consentRef],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('3. an unresolved template digest is retained and flagged; registration resolves it', async () => {
    const p = await person('Synthetic Consent Template');
    const digest = `sha256:${'c'.repeat(64)}`;
    const c = okC(
      await capture(body(p, { templateRef: 'synthetic-consent-v9', templateDigest: digest })),
    ).data;
    expect([c.templateDigest, c.templateStatus]).toStrictEqual([digest, 'unresolved']);
    const reg = await h.call('a1', 'POST', '/v1/clinical/consent-templates', {
      templateRef: 'synthetic-consent-v9',
      digest,
    });
    expect(reg.statusCode).toBe(201);
    expect(validateConsentTemplateCommandResult(reg.json())).toBe(true);
    const read = h.ok<{ data: Consent }>(await h.call('a1', 'GET', `${CONSENTS}/${c.consentRef}`)).data;
    expect(read.templateStatus).toBe('registered');
    const dup = await h.call('a1', 'POST', '/v1/clinical/consent-templates', {
      templateRef: 'synthetic-consent-v9',
      digest,
    });
    expect(reason(dup)).toStrictEqual([409, 'template_registered']);
    // Registration is practice configuration (admin.configure); a read-only clinical member cannot register.
    expect(
      (await h.call('a4', 'POST', '/v1/clinical/consent-templates', { templateRef: 'synthetic-x', digest }))
        .statusCode,
    ).toBe(403);
  });

  it('4. a merged patient’s consents stay distinct with their original signer relationships', async () => {
    const survivor = await person('Synthetic Consent Merge');
    const merged = await person('Synthetic Consent Merge');
    const helper = await person('Synthetic Consent Helper');
    const rel = await relate(merged, helper, 'proxy', ['consent']);
    const c = okC(
      await capture(body(merged, { signer: { kind: 'related_person', personRef: helper } })),
    ).data;
    const own = okC(await capture(body(survivor))).data;
    const snapshot = async () =>
      (
        await db.admin.query(
          `SELECT to_jsonb(c) - ARRAY['subject_patient_id', 'version', 'updated_at'] AS j FROM cuspatlas.clinical_consents c
           WHERE id = $1`,
          [c.consentRef],
        )
      ).rows[0].j;
    const before = await snapshot();
    await mergePatients(h, survivor, merged);
    expect(await snapshot()).toStrictEqual(before);
    const all = (await list(survivor)).data;
    expect(
      all.map((x) => [x.consentRef, x.sourcePatientRef, x.signer.relationshipRefs]).sort(),
    ).toStrictEqual(
      [
        [c.consentRef, merged, [rel]],
        [own.consentRef, survivor, []],
      ].sort(),
    );
  });
});

describe('C13 enforcement, privacy and parity', () => {
  it('consent and withdrawal rows are immutable under the runtime role', async () => {
    const p = await person('Synthetic Consent Immutable');
    const c = okC(await capture(body(p))).data;
    const run = createTenantTransactionRunner(db.app);
    const ctx = ctxFor(T_ALPHA, USER_A1, 'human');
    const other = await person('Synthetic Consent Other');
    for (const sql of [
      `UPDATE cuspatlas.clinical_consents SET attestation_code = 'other', version = version + 1 WHERE id = '${c.consentRef}'`,
      `DELETE FROM cuspatlas.clinical_consents WHERE id = '${c.consentRef}'`,
      `DELETE FROM cuspatlas.clinical_consent_withdrawals`,
      // A patient reference moves only with a recorded merge (checked at commit).
      `UPDATE cuspatlas.clinical_consents SET subject_patient_id = '${other}', version = version + 1 WHERE id = '${c.consentRef}'`,
    ]) {
      await expect(run(ctx, (tx) => tx.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('a read-only member reads but cannot capture; a service principal cannot capture', async () => {
    const p = await person('Synthetic Consent Roles');
    const c = okC(await capture(body(p))).data;
    expect((await capture(body(p), 'a4')).statusCode).toBe(403);
    expect((await capture(body(p), 'svcA1')).statusCode).toBe(403);
    expect((await h.call('a4', 'GET', `${CONSENTS}/${c.consentRef}`)).statusCode).toBe(200);
  });

  it('the marker never leaks; MCP capture replays a REST key and reads match', async () => {
    const p = await person('Synthetic Consent Parity');
    await capture(body(p, { attestationCode: 'synthetic_secret' }));
    await capture(body(p, { templateRef: MARKER }));
    const key = randomUUID();
    const rest = okC(await capture(body(p), 'a1', key));
    const viaMcp = await h.mcp('a1', 'clinical_consents_capture', { ...body(p), idempotencyKey: key }, 201);
    expect([viaMcp.code, (viaMcp.body as { replayed: boolean }).replayed]).toStrictEqual([null, true]);
    const mcpRead = await h.mcp('a1', 'clinical_consents_get', { consentRef: rest.data.consentRef });
    const restRead = h.ok<{ data: Consent }>(
      await h.call('a1', 'GET', `${CONSENTS}/${rest.data.consentRef}`),
    );
    expect((mcpRead.body as { data: Consent }).data).toStrictEqual(restRead.data);
    const foreign = await h.mcp('b1', 'clinical_consents_get', { consentRef: rest.data.consentRef });
    expect([foreign.status, foreign.code]).toStrictEqual([404, 'not_found']);
    const reads = (
      await db.admin.query(
        `SELECT coalesce(json_agg(t)::text, '') AS j FROM cuspatlas.sensitive_read_events t`,
      )
    ).rows[0].j as string;
    expect(`${await leakTables(db)}${reads}${h.logLines.join('\n')}`).not.toContain(MARKER);
  });
});
