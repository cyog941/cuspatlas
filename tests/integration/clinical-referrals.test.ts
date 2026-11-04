import { randomUUID } from 'node:crypto';
import {
  validateReferralCommandResult,
  validateReferralExport,
  validateReferralList,
  validateReferralRead,
} from '@cuspatlas/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLINICAL_RECORD_ROUTES } from '../../apps/api/src/routes/clinical-record-manifest';
import {
  type AppointmentHarness,
  count,
  createPatient,
  leakTables,
  mergePatients,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
  T_BETA,
} from './support/appointment-fixtures';
import { seedClinicalScopes } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { MARKER } from './support/marker';

/**
 * C17: referral records (synthetic engineering implementation; C-D10 recommended option:
 * record-keeping plus print/export only, with an explicit share record for any cross-practice
 * disclosure, until C-S4 verifies a channel). Incoming and outgoing referrals; the package is an
 * explicit, recorded selection; responses carry their source and are never attributed to the
 * referring clinician; response tracking is an exception-first worklist (PT-03).
 */
let db: TestDatabase;
let h: AppointmentHarness;
const REF = '/v1/clinical/referrals';
const DIGEST = `sha256:${'e'.repeat(64)}`;
const DISCLOSURE_TEMPLATE = 'synthetic-disclosure-consent';
const LOC = 'loc-referrals';
type Referral = {
  referralRef: string;
  patientRef: string;
  sourcePatientRef: string;
  direction: string;
  counterpartyRef: string;
  reasonCode: string;
  state: string;
  consentRef: string | null;
  possibleDuplicateOf: string | null;
  selections: { kind: string; ref: string }[];
  shares: { shareRef: string; purposeCode: string; scope: string[]; expiresAt: string }[];
  responses: {
    sourceRef: string;
    receivedDate: string;
    documentRefs: string[];
    attribution: string;
    recordedBy: string;
  }[];
  events: {
    kind: string;
    fromState: string | null;
    toState: string;
    reasonCode: string | null;
    errorCode: string | null;
  }[];
  responseOverdue: boolean;
  version: number;
};

beforeAll(async () => {
  db = await openTestDatabase('clinical_referrals');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedClinicalScopes(db.admin);
  await seedLocation(h, LOC);
  for (const tenant of [T_ALPHA, T_BETA]) {
    await db.admin.query(
      'INSERT INTO cuspatlas.clinical_referral_policies (tenant_id, disclosure_consent_template_ref) VALUES ($1, $2)',
      [tenant, DISCLOSURE_TEMPLATE],
    );
  }
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

async function disclosureConsent(patientRef: string, who = 'a1', templateRef = DISCLOSURE_TEMPLATE) {
  return h.ok<{ data: { consentRef: string } }>(
    await h.call(
      who,
      'POST',
      '/v1/clinical/consents',
      {
        patientRef,
        scope: 'general_treatment',
        method: 'in_person',
        templateRef,
        templateDigest: DIGEST,
        attestationCode: 'signed_in_person',
        signer: { kind: 'patient' },
      },
      randomUUID(),
    ),
    201,
  ).data.consentRef;
}
/** One rendered procedure for the patient (a record the package can select). */
async function procedure(patientRef: string) {
  const e = h.ok<{ data: { encounter: { encounterRef: string; version: number } } }>(
    await h.call('a1', 'POST', '/v1/clinical/encounters', { patientRef, locationRef: LOC }),
    201,
  ).data.encounter;
  return h.ok<{ data: { procedureRef: string } }>(
    await h.call(
      'a1',
      'POST',
      `/v1/clinical/encounters/${e.encounterRef}/procedures`,
      {
        sequence: 1,
        dateOfService: '2026-10-01',
        renderingProviderRef: (
          await db.admin.query(
            `SELECT r.id FROM cuspatlas.scheduling_resources r JOIN cuspatlas.scheduling_locations l ON l.id = r.location_id
             WHERE l.location_ref = $1 AND r.kind = 'provider' LIMIT 1`,
            [LOC],
          )
        ).rows[0].id,
        codeRef: 'SYN-PROC-REF',
        providerOverrideReason: 'referral_fixture',
      },
      randomUUID(),
    ),
    201,
  ).data.procedureRef;
}
async function chartEntry(patientRef: string) {
  return h.ok<{ data: { entry: { entryRef: string } } }>(
    await h.call('a1', 'POST', '/v1/clinical/chart/entries', {
      patientRef,
      provenance: 'recorded',
      tooth: { system: 'universal', code: '30' },
      kind: 'condition',
      findingRef: 'SYN-COND-200',
    }),
    201,
  ).data.entry.entryRef;
}
const create = (body: Record<string, unknown>, who = 'a1', key = randomUUID()) =>
  h.call(who, 'POST', REF, body, key);
const okR = (res: Awaited<ReturnType<AppointmentHarness['call']>>, status = 201) => {
  const json = h.ok<{ data: Referral; replayed: boolean }>(res, status);
  expect(validateReferralCommandResult(json)).toBe(true);
  return json.data;
};
const post = (ref: string, path: string, body: Record<string, unknown>, who = 'a1', key = randomUUID()) =>
  h.call(who, 'POST', `${REF}/${ref}/${path}`, body, key);
const reason = (res: Awaited<ReturnType<AppointmentHarness['call']>>) => [
  res.statusCode,
  res.json().detail?.reason ?? res.json().detail?.violations?.[0]?.rule ?? res.json().code,
];
async function read(ref: string, who = 'a1') {
  const json = h.ok<{ data: Referral }>(await h.call(who, 'GET', `${REF}/${ref}`));
  expect(validateReferralRead(json)).toBe(true);
  return json.data;
}
const lab = () => `syn-practice-${randomUUID().slice(0, 8)}`;
async function outgoing(patientRef: string, extra: Record<string, unknown> = {}) {
  return okR(
    await create({
      patientRef,
      direction: 'outgoing',
      counterpartyRef: lab(),
      reasonCode: 'endodontic_evaluation',
      requestedScope: 'consult_and_treat',
      consentRef: await disclosureConsent(patientRef),
      responseDueDate: '2030-06-01',
      ...extra,
    }),
  );
}
const share = (
  ref: string,
  scope: string[],
  expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString(),
) => post(ref, 'shares', { purposeCode: 'continuity_of_care', scope, expiresAt });
type Work = { kind: string; evidenceRefs: { ref: string }[] };
async function worklist(asOf?: string) {
  return h.ok<{ data: { items: Work[] } }>(
    await h.call('a1', 'GET', `${REF}/worklist${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`),
  ).data;
}
const itemsFor = (w: { items: Work[] }, ref: string) =>
  w.items.filter((i) => i.evidenceRefs.some((e) => e.ref === ref)).map((i) => i.kind);

describe('C17 acceptance cases', () => {
  it('1. a package from an explicit selection contains exactly the selected references, retrievable afterwards', async () => {
    const p = await createPatient(h, 'Synthetic Referral Package');
    const proc = await procedure(p);
    const entry = await chartEntry(p);
    await chartEntry(p); // not selected
    const r = await outgoing(p);
    const prepared = okR(
      await post(r.referralRef, 'package', {
        expectedVersion: 1,
        selections: [
          { kind: 'renderedProcedure', ref: proc },
          { kind: 'chartEntry', ref: entry },
        ],
      }),
      200,
    );
    expect(prepared.selections).toStrictEqual([
      { kind: 'chartEntry', ref: entry },
      { kind: 'renderedProcedure', ref: proc },
    ]);
    expect((await read(r.referralRef)).selections).toStrictEqual(prepared.selections);
    okR(await share(r.referralRef, ['chartEntry', 'renderedProcedure']));
    const sent = okR(await post(r.referralRef, 'sent', { expectedVersion: 3, channel: 'print' }), 200);
    expect(sent.state).toBe('sent');
    const exp = h.ok<{ data: { format: string; referral: Referral } }>(
      await h.call('a1', 'GET', `${REF}/${r.referralRef}/export`),
    );
    expect(validateReferralExport(exp)).toBe(true);
    expect([exp.data.format, exp.data.referral.selections]).toStrictEqual([
      'cuspatlas-referral-export/1',
      prepared.selections,
    ]);
    // Nothing is shared by default: the export holds references only, never record content.
    expect(JSON.stringify(exp)).not.toContain('SYN-COND-200');
  });

  it('2. an outgoing referral without the configured disclosure consent is refused', async () => {
    const p = await createPatient(h, 'Synthetic Referral Consent');
    const base = {
      patientRef: p,
      direction: 'outgoing',
      counterpartyRef: lab(),
      reasonCode: 'oral_surgery',
      requestedScope: 'consult',
    };
    expect(reason(await create(base))).toStrictEqual([409, 'disclosure_consent_required']);
    const wrongTemplate = await disclosureConsent(p, 'a1', 'synthetic-other-consent');
    expect(reason(await create({ ...base, consentRef: wrongTemplate }))).toStrictEqual([
      409,
      'disclosure_consent_required',
    ]);
    const c = await disclosureConsent(p);
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/consents/${c}/withdrawal`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
        signer: { kind: 'patient' },
      }),
      201,
    );
    expect(reason(await create({ ...base, consentRef: c }))).toStrictEqual([
      409,
      'disclosure_consent_required',
    ]);
    // An incoming referral is record-keeping of what another practice sent: no disclosure by us.
    okR(await create({ ...base, direction: 'incoming' }));
  });

  it('3. sending without a share record, beyond its scope or after its expiry is refused', async () => {
    const p = await createPatient(h, 'Synthetic Referral Share');
    const proc = await procedure(p);
    const entry = await chartEntry(p);
    const r = await outgoing(p);
    okR(
      await post(r.referralRef, 'package', {
        expectedVersion: 1,
        selections: [
          { kind: 'renderedProcedure', ref: proc },
          { kind: 'chartEntry', ref: entry },
        ],
      }),
      200,
    );
    expect(
      reason(await post(r.referralRef, 'sent', { expectedVersion: 2, channel: 'export' })),
    ).toStrictEqual([409, 'share_record_required']);
    okR(await share(r.referralRef, ['renderedProcedure']));
    expect(
      reason(await post(r.referralRef, 'sent', { expectedVersion: 3, channel: 'export' })),
    ).toStrictEqual([409, 'share_scope_exceeded']);
    expect(
      reason(await share(r.referralRef, ['chartEntry', 'renderedProcedure'], '2020-01-01T00:00:00Z')),
    ).toStrictEqual([422, 'expiresInPast']);
    okR(
      await share(
        r.referralRef,
        ['chartEntry', 'renderedProcedure'],
        new Date(Date.now() + 1500).toISOString(),
      ),
    );
    await new Promise((res) => setTimeout(res, 2000));
    expect(
      reason(await post(r.referralRef, 'sent', { expectedVersion: 4, channel: 'export' })),
    ).toStrictEqual([409, 'share_expired']);
    expect((await h.call('a1', 'GET', `${REF}/${r.referralRef}/export`)).statusCode).toBe(409);
  });

  it('4. a returned record is stored with its source and is not presented as authored by the referring clinician', async () => {
    const p = await createPatient(h, 'Synthetic Referral Response');
    const proc = await procedure(p);
    const r = await outgoing(p);
    okR(
      await post(r.referralRef, 'package', {
        expectedVersion: 1,
        selections: [{ kind: 'renderedProcedure', ref: proc }],
      }),
      200,
    );
    okR(await share(r.referralRef, ['renderedProcedure']));
    okR(await post(r.referralRef, 'sent', { expectedVersion: 3, channel: 'print' }), 200);
    const answered = okR(
      await post(r.referralRef, 'responses', {
        expectedVersion: 4,
        sourceRef: r.counterpartyRef,
        receivedDate: '2030-05-30',
        documentRefs: ['syn-obj-consult-1'],
      }),
      200,
    );
    expect(answered.state).toBe('responded');
    expect(answered.responses).toMatchObject([
      {
        sourceRef: r.counterpartyRef,
        receivedDate: '2030-05-30',
        documentRefs: ['syn-obj-consult-1'],
        attribution: 'external_source',
      },
    ]);
    const closed = okR(
      await post(r.referralRef, 'close', { expectedVersion: 5, reasonCode: 'care_completed' }),
      200,
    );
    expect(closed.events.map((e) => e.kind)).toStrictEqual([
      'created',
      'package_prepared',
      'share_recorded',
      'sent',
      'response_recorded',
      'closed',
    ]);
  });

  it('5. a duplicate referral to the same counterparty for the same reason is flagged for confirmation', async () => {
    const p = await createPatient(h, 'Synthetic Referral Duplicate');
    const cp = lab();
    const first = await outgoing(p, { counterpartyRef: cp });
    const body = {
      patientRef: p,
      direction: 'outgoing',
      counterpartyRef: cp,
      reasonCode: 'endodontic_evaluation',
      requestedScope: 'consult_and_treat',
      consentRef: first.consentRef,
    };
    const dup = await create(body);
    expect(reason(dup)).toStrictEqual([409, 'referral_possible_duplicate']);
    expect(dup.json().detail.blockingRefs).toStrictEqual([{ kind: 'referral', ref: first.referralRef }]);
    const confirmed = okR(await create({ ...body, confirmDuplicate: true }));
    expect(confirmed.possibleDuplicateOf).toBe(first.referralRef);
    expect(itemsFor(await worklist(), confirmed.referralRef)).toContain('referral_review');
  });

  it('6. another tenant’s referral read or update is denied; no electronic exchange command exists', async () => {
    const p = await createPatient(h, 'Synthetic Referral Tenant');
    const r = await outgoing(p);
    expect((await h.call('b1', 'GET', `${REF}/${r.referralRef}`)).statusCode).toBe(404);
    expect(
      (await post(r.referralRef, 'close', { expectedVersion: 1, reasonCode: 'x_reason' }, 'b1')).statusCode,
    ).toBe(404);
    const beta = await createPatient(h, 'Synthetic Referral Beta', 'b1');
    expect(
      (
        await create({
          patientRef: beta,
          direction: 'incoming',
          counterpartyRef: lab(),
          reasonCode: 'consult',
          requestedScope: 'consult',
        })
      ).statusCode,
    ).toBe(404);
    const ops = CLINICAL_RECORD_ROUTES.filter((x) => x.path.includes('referrals')).map((x) => x.operationId);
    expect(ops.filter((id) => /transmit|exchange|direct|fhir|fax|email/i.test(id))).toStrictEqual([]);
  });
});

describe('C17 failure and recovery cases', () => {
  it('1. a failed package preparation writes no partial selection and no audit success', async () => {
    const p = await createPatient(h, 'Synthetic Referral Partial');
    const proc = await procedure(p);
    const other = await createPatient(h, 'Synthetic Referral Partial Other');
    const foreignEntry = await chartEntry(other);
    const r = await outgoing(p);
    const before = [await count(db, 'clinical_referral_selections'), await count(db, 'audit_events')];
    const res = await post(r.referralRef, 'package', {
      expectedVersion: 1,
      selections: [
        { kind: 'renderedProcedure', ref: proc },
        { kind: 'chartEntry', ref: foreignEntry },
      ],
    });
    expect(reason(res)).toStrictEqual([422, 'selectionNotOfPatient']);
    expect([await count(db, 'clinical_referral_selections'), await count(db, 'audit_events')]).toStrictEqual(
      before,
    );
    expect((await read(r.referralRef)).selections).toStrictEqual([]);
  });

  it('2. a transmission failure records the error and keeps the prepared state; the explicit retry is idempotent', async () => {
    const p = await createPatient(h, 'Synthetic Referral Failure');
    const proc = await procedure(p);
    const r = await outgoing(p);
    okR(
      await post(r.referralRef, 'package', {
        expectedVersion: 1,
        selections: [{ kind: 'renderedProcedure', ref: proc }],
      }),
      200,
    );
    okR(await share(r.referralRef, ['renderedProcedure']));
    const failed = okR(
      await post(r.referralRef, 'transmission-failures', { errorCode: 'printer_unavailable' }),
    );
    expect([failed.state, failed.events.at(-1)?.kind, failed.events.at(-1)?.errorCode]).toStrictEqual([
      'prepared',
      'transmission_failed',
      'printer_unavailable',
    ]);
    const key = randomUUID();
    const sent = okR(
      await post(r.referralRef, 'sent', { expectedVersion: 4, channel: 'print' }, 'a1', key),
      200,
    );
    const again = await post(r.referralRef, 'sent', { expectedVersion: 4, channel: 'print' }, 'a1', key);
    expect([again.statusCode, again.json().replayed, again.json().data.version]).toStrictEqual([
      200,
      true,
      sent.version,
    ]);
  });

  it('3. a referral recalled after sending is a correction with a reason; the sent fact stays', async () => {
    const p = await createPatient(h, 'Synthetic Referral Recall');
    const proc = await procedure(p);
    const r = await outgoing(p);
    okR(
      await post(r.referralRef, 'package', {
        expectedVersion: 1,
        selections: [{ kind: 'renderedProcedure', ref: proc }],
      }),
      200,
    );
    okR(await share(r.referralRef, ['renderedProcedure']));
    okR(await post(r.referralRef, 'sent', { expectedVersion: 3, channel: 'print' }), 200);
    const recalled = okR(
      await post(r.referralRef, 'recall', { expectedVersion: 4, reasonCode: 'wrong_counterparty' }),
      200,
    );
    expect([recalled.state, recalled.events.map((e) => e.kind).slice(-2)]).toStrictEqual([
      'cancelled',
      ['sent', 'recalled'],
    ]);
    expect(recalled.events.at(-1)?.reasonCode).toBe('wrong_counterparty');
  });

  it('4. a merged patient’s referral keeps its package selection and records the new patient reference', async () => {
    const survivor = await createPatient(h, 'Synthetic Referral Merge');
    const merged = await createPatient(h, 'Synthetic Referral Merge');
    const proc = await procedure(merged);
    const r = await outgoing(merged);
    okR(
      await post(r.referralRef, 'package', {
        expectedVersion: 1,
        selections: [{ kind: 'renderedProcedure', ref: proc }],
      }),
      200,
    );
    await mergePatients(h, survivor, merged);
    const after = await read(r.referralRef);
    expect([after.patientRef, after.sourcePatientRef, after.selections]).toStrictEqual([
      survivor,
      merged,
      [{ kind: 'renderedProcedure', ref: proc }],
    ]);
  });
});

describe('C17 boundaries', () => {
  it('response tracking: a sent referral past its response due date is a work item without any state change', async () => {
    const p = await createPatient(h, 'Synthetic Referral Due');
    const proc = await procedure(p);
    const r = await outgoing(p, { responseDueDate: '2026-02-01' });
    okR(
      await post(r.referralRef, 'package', {
        expectedVersion: 1,
        selections: [{ kind: 'renderedProcedure', ref: proc }],
      }),
      200,
    );
    okR(await share(r.referralRef, ['renderedProcedure']));
    okR(await post(r.referralRef, 'sent', { expectedVersion: 3, channel: 'print' }), 200);
    const before = await read(r.referralRef);
    expect(itemsFor(await worklist('2026-03-01T12:00:00Z'), r.referralRef)).toStrictEqual([
      'referral_response_due',
    ]);
    expect(itemsFor(await worklist('2026-01-15T12:00:00Z'), r.referralRef)).toStrictEqual([]);
    const after = await read(r.referralRef);
    expect([after.version, after.state]).toStrictEqual([before.version, 'sent']);
    // An incoming referral we owe a response to is tracked the same way.
    const inc = okR(
      await create({
        patientRef: p,
        direction: 'incoming',
        counterpartyRef: lab(),
        reasonCode: 'consult',
        requestedScope: 'consult',
        responseDueDate: '2026-02-01',
      }),
    );
    expect(inc.state).toBe('received');
    expect(itemsFor(await worklist('2026-03-01T12:00:00Z'), inc.referralRef)).toStrictEqual([
      'referral_response_due',
    ]);
  });

  it('roles, tenant, marker and MCP replay; referral events are append-only under the runtime role', async () => {
    const p = await createPatient(h, 'Synthetic Referral Roles');
    const body = {
      patientRef: p,
      direction: 'incoming',
      counterpartyRef: lab(),
      reasonCode: 'consult',
      requestedScope: 'consult',
    };
    expect(reason(await create(body, 'a4'))).toStrictEqual([403, 'forbidden']);
    expect(reason(await create(body, 'svcA1'))).toStrictEqual([403, 'forbidden']);
    expect((await create({ ...body, tenantId: T_BETA })).statusCode).toBe(400);
    await create({ ...body, counterpartyRef: lab(), note: MARKER });
    const key = randomUUID();
    const rest = okR(await create(body, 'a1', key));
    const m = await h.mcp('a1', 'clinical_referrals_create', { ...body, idempotencyKey: key }, 201);
    expect([m.code, (m.body as { replayed: boolean }).replayed]).toStrictEqual([null, true]);
    const got = await h.mcp('a1', 'clinical_referrals_get', { referralRef: rest.referralRef });
    expect((got.body as { data: Referral }).data).toStrictEqual(await read(rest.referralRef));
    const list = h.ok<{ data: Referral[] }>(
      await h.call('a4', 'GET', `/v1/clinical/patients/${p}/referrals`),
    );
    expect(validateReferralList(list)).toBe(true);
    expect(`${await leakTables(db)}${h.logLines.join('\n')}`).not.toContain(MARKER);
    const client = await db.app.connect();
    try {
      for (const sql of [
        `UPDATE cuspatlas.clinical_referral_events SET to_state = 'closed' WHERE referral_id = $1`,
        'DELETE FROM cuspatlas.clinical_referral_events WHERE referral_id = $1',
        `UPDATE cuspatlas.clinical_referrals SET counterparty_ref = 'syn-x' WHERE id = $1`,
        'DELETE FROM cuspatlas.clinical_referrals WHERE id = $1',
      ]) {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
        const code = await client.query(sql, [rest.referralRef]).then(
          () => 'ok',
          (err: { code?: string }) => err.code,
        );
        await client.query('ROLLBACK');
        expect([sql, code]).toStrictEqual([sql, '42501']);
      }
    } finally {
      client.release();
    }
  });
});

describe('C17 export re-checks consent and lifecycle (review hardening)', () => {
  async function prepared(name: string) {
    const p = await createPatient(h, name);
    const entry = await chartEntry(p);
    const r = await outgoing(p);
    okR(
      await post(r.referralRef, 'package', {
        expectedVersion: 1,
        selections: [{ kind: 'chartEntry', ref: entry }],
      }),
      200,
    );
    okR(await share(r.referralRef, ['chartEntry']));
    expect((await h.call('a1', 'GET', `${REF}/${r.referralRef}/export`)).statusCode).toBe(200);
    return r;
  }

  it('a referral whose disclosure consent was withdrawn is not exported', async () => {
    const r = await prepared('Synthetic Referral Export Withdrawn');
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/consents/${r.consentRef}/withdrawal`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
        signer: { kind: 'patient' },
      }),
      201,
    );
    expect(reason(await h.call('a1', 'GET', `${REF}/${r.referralRef}/export`))).toStrictEqual([
      409,
      'disclosure_consent_required',
    ]);
  });

  it('a cancelled referral is not exported', async () => {
    const r = await prepared('Synthetic Referral Export Cancelled');
    okR(await post(r.referralRef, 'close', { expectedVersion: 3, reasonCode: 'no_longer_needed' }), 200);
    expect((await read(r.referralRef)).state).toBe('cancelled');
    expect(reason(await h.call('a1', 'GET', `${REF}/${r.referralRef}/export`))).toStrictEqual([
      409,
      'referral_step_not_allowed',
    ]);
  });
});
