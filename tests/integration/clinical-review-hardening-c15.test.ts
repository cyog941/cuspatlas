import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  createPatient,
  mergePatients,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
  USER_A1,
} from './support/appointment-fixtures';
import { seedClinicalScopes } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { SVC_A1 } from './support/fixtures';
import { fakeImageResolver } from './support/image-ref-resolver';

/**
 * Hardening of C15-C18 and of the S6 reversal guard after the independent review of c-chart 3b242d4
 * (synthetic data only). Every forged write runs under the runtime role `cuspatlas_app` with tenant and
 * actor context, exactly as the application does, and commits so deferred checks run.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
const images = fakeImageResolver();
const LOC = 'loc-c15-hardening';
const LAB = '/v1/clinical/lab-cases';
const REF = '/v1/clinical/referrals';
const DISCLOSURE_TEMPLATE = 'synthetic-disclosure-consent';
let slot = 0;

beforeAll(async () => {
  db = await openTestDatabase('clinical_review_hardening_c15');
  h = await openAppointmentHarness(db, { mcp: false, imageRefResolver: images });
  await seedClinicalScopes(db.admin);
  loc = await seedLocation(h, LOC);
  await db.admin.query(
    'INSERT INTO cuspatlas.clinical_referral_policies (tenant_id, disclosure_consent_template_ref) VALUES ($1, $2)',
    [T_ALPHA, DISCLOSURE_TEMPLATE],
  );
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

/** Runs statements in one runtime-role transaction and commits; returns 'ok' or the SQLSTATE. */
async function commit(statements: readonly [string, unknown[]?][], actor = USER_A1): Promise<string> {
  const client = await db.app.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
    await client.query(`SELECT set_config('cuspatlas.actor_id', $1, true)`, [actor]);
    for (const [sql, params] of statements) await client.query(sql, params ?? []);
    await client.query('COMMIT');
    return 'ok';
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    return (e as { code?: string }).code ?? 'error';
  } finally {
    client.release();
  }
}
const reason = (res: Awaited<ReturnType<AppointmentHarness['call']>>) => [
  res.statusCode,
  res.json().detail?.reason ?? res.json().detail?.violations?.[0]?.rule ?? res.json().code,
];
const subjectOf = async (table: string, id: string) =>
  (await db.admin.query(`SELECT subject_patient_id FROM cuspatlas.${table} WHERE id = $1`, [id])).rows[0]
    .subject_patient_id as string;
const unmerge = (mergeRef: string) =>
  h.call('a1', 'POST', `/v1/patients/merges/${mergeRef}/unmerge`, { reasonCode: 'merged_in_error' });
const relinkTo = (table: string, id: string, patient: string): [string, unknown[]] => [
  `UPDATE cuspatlas.${table} SET subject_patient_id = $1, version = version + 1, updated_at = now() WHERE id = $2`,
  [patient, id],
];

async function newPlan(patientRef: string) {
  return h.ok<{ data: { plan: { planRef: string } } }>(
    await h.call('a1', 'POST', '/v1/clinical/treatment-plans', { patientRef }, randomUUID()),
    201,
  ).data.plan.planRef;
}
async function newLabCase(patientRef: string, counterpartyRef = `syn-lab-${randomUUID().slice(0, 8)}`) {
  return h.ok<{ data: { labCaseRef: string } }>(
    await h.call('a1', 'POST', LAB, { patientRef, counterpartyRef, caseRef: 'SYN-CASE-H15' }, randomUUID()),
    201,
  ).data.labCaseRef;
}
async function newIncomingReferral(patientRef: string) {
  return h.ok<{ data: { referralRef: string } }>(
    await h.call(
      'a1',
      'POST',
      REF,
      {
        patientRef,
        direction: 'incoming',
        counterpartyRef: `syn-practice-${randomUUID().slice(0, 8)}`,
        reasonCode: 'endodontic_evaluation',
        requestedScope: 'consult',
      },
      randomUUID(),
    ),
    201,
  ).data.referralRef;
}
async function newOutgoingReferral(patientRef: string) {
  const consentRef = h.ok<{ data: { consentRef: string } }>(
    await h.call(
      'a1',
      'POST',
      '/v1/clinical/consents',
      {
        patientRef,
        scope: 'general_treatment',
        method: 'in_person',
        templateRef: DISCLOSURE_TEMPLATE,
        templateDigest: `sha256:${'e'.repeat(64)}`,
        attestationCode: 'signed_in_person',
        signer: { kind: 'patient' },
      },
      randomUUID(),
    ),
    201,
  ).data.consentRef;
  return h.ok<{ data: { referralRef: string } }>(
    await h.call(
      'a1',
      'POST',
      REF,
      {
        patientRef,
        direction: 'outgoing',
        counterpartyRef: `syn-practice-${randomUUID().slice(0, 8)}`,
        reasonCode: 'endodontic_evaluation',
        requestedScope: 'consult',
        consentRef,
      },
      randomUUID(),
    ),
    201,
  ).data.referralRef;
}
async function appointment(patientRef: string) {
  const day = 1 + Math.floor(slot / 8) * 7;
  const hour = 13 + (slot % 8);
  slot += 1;
  const at = (hh: number) => new Date(Date.UTC(2030, 3, day, hh)).toISOString();
  return h.ok<{ data: { appointmentRef: string } }>(
    await h.call('a1', 'POST', '/v1/scheduling/appointments', {
      patientRef,
      locationRef: loc.locationRef,
      startsAt: at(hour),
      endsAt: at(hour + 1),
      timeZone: 'America/New_York',
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
    }),
    201,
  ).data.appointmentRef;
}

/**
 * The stale-reversal scenario: m1 (merged → survivor) moves the record and is reversed; the pair is
 * merged again (m2), moving the record a second time. A bare relink back to the merged patient in an
 * unrelated transaction must not borrow m1's reversal.
 */
async function staleReversal(table: string, make: (patient: string) => Promise<string>) {
  const survivor = await createPatient(h, `Synthetic Stale ${table}`);
  const merged = await createPatient(h, `Synthetic Stale ${table}`);
  const record = await make(merged);
  const m1 = await mergePatients(h, survivor, merged);
  expect(await subjectOf(table, record)).toBe(survivor);
  expect((await unmerge(m1)).statusCode).toBe(200);
  expect(await subjectOf(table, record)).toBe(merged);
  const m2 = await mergePatients(h, survivor, merged);
  expect(await subjectOf(table, record)).toBe(survivor);
  expect(await commit([relinkTo(table, record, merged)])).toBe('42501');
  expect(await subjectOf(table, record)).toBe(survivor);
  // The real unmerge of m2 still relinks the record back (control).
  expect((await unmerge(m2)).statusCode).toBe(200);
  expect(await subjectOf(table, record)).toBe(merged);
}

describe('MUST 1: a reversal relink is bound to the reversal recorded in its own transaction', () => {
  it('treatment plan: a bare relink after a reversed and repeated merge is refused; the real unmerge passes', async () => {
    await staleReversal('clinical_treatment_plans', newPlan);
  });

  it('lab case: the same stale reversal is refused', async () => {
    await staleReversal('clinical_lab_cases', (p) => newLabCase(p));
  });

  it('referral: the same stale reversal is refused', async () => {
    await staleReversal('clinical_referrals', newIncomingReferral);
  });

  it('a forward relink to the survivor needs the merge of its own transaction', async () => {
    const survivor = await createPatient(h, 'Synthetic Stale Forward');
    const merged = await createPatient(h, 'Synthetic Stale Forward');
    const plan = await newPlan(merged);
    const m1 = await mergePatients(h, survivor, merged);
    expect((await unmerge(m1)).statusCode).toBe(200);
    // The record is back with the merged patient; m1's move row does not license a later relink.
    expect(await commit([relinkTo('clinical_treatment_plans', plan, survivor)])).toBe('42501');
    expect(await subjectOf('clinical_treatment_plans', plan)).toBe(merged);
  });

  it('every reference move observed in a merge transaction is listed as a move of that merge', async () => {
    const survivor = await createPatient(h, 'Synthetic Unlisted Move');
    const merged = await createPatient(h, 'Synthetic Unlisted Move');
    const plan = await newPlan(merged);
    const appt = await appointment(merged);
    const digest = (
      await db.admin.query(
        `SELECT encode(sha256(convert_to((to_jsonb(r) - 'subject_patient_id' - 'head_version' - 'version'
           - 'updated_at')::text, 'UTF8')), 'hex') AS d FROM cuspatlas.clinical_treatment_plans r WHERE id = $1`,
        [plan],
      )
    ).rows[0].d as string;
    const mergeId = randomUUID();
    const statements = (withAppointment: boolean): [string, unknown[]][] => [
      relinkTo('clinical_treatment_plans', plan, survivor),
      ...(withAppointment ? [relinkTo('appointments', appt, survivor)] : []),
      [
        `INSERT INTO cuspatlas.patient_merges (id, tenant_id, survivor_patient_id, merged_patient_id,
           survivor_version_before, merged_version_before, survivor_digest, merged_digest, reason_code, move_count,
           merged_by)
         VALUES ($1, cuspatlas.current_tenant_id(), $2, $3, 1, 1, cuspatlas.patient_identity_digest($2),
           cuspatlas.patient_identity_digest($3), 'duplicate_registration', 1, cuspatlas.current_actor_id())`,
        [mergeId, survivor, merged],
      ],
      [
        `INSERT INTO cuspatlas.patient_merge_moves (tenant_id, merge_id, record_class, record_ref, reference_column,
           prior_patient_id, new_patient_id, content_digest_before, content_digest_after)
         VALUES (cuspatlas.current_tenant_id(), $1, 'clinicalTreatmentPlan', $2, 'subject_patient_id', $3, $4, $5, $5)`,
        [mergeId, plan, merged, survivor, digest],
      ],
      [
        'UPDATE cuspatlas.patients SET merged_into = $1, version = version + 1 WHERE id = $2',
        [survivor, merged],
      ],
    ];
    // The appointment moved in the merge transaction but is not listed: refused at commit.
    expect(await commit(statements(true))).toBe('42501');
    expect(await subjectOf('appointments', appt)).toBe(merged);
    // The same merge without the unlisted move commits (control).
    expect(await commit(statements(false))).toBe('ok');
    expect(await subjectOf('clinical_treatment_plans', plan)).toBe(survivor);
  });
});

/** Holds a SHARE lock on a table so concurrent inserts queue after their pre-checks, then releases it. */
async function raceInserts(
  table: string,
  calls: (() => ReturnType<AppointmentHarness['call']>)[],
  waiters = calls.length,
) {
  const holder = await db.admin.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`LOCK TABLE cuspatlas.${table} IN SHARE MODE`);
    const pending = calls.map((c) => c());
    const deadline = Date.now() + 20_000;
    for (;;) {
      const { rows } = await db.admin.query(
        `SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND relation = $1::regclass`,
        [`cuspatlas.${table}`],
      );
      if (rows[0].n >= waiters || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await holder.query('COMMIT');
    return await Promise.all(pending);
  } finally {
    holder.release();
  }
}

describe('SHOULD b: unique-index races are typed 409s, never a 500', () => {
  it('two concurrent lab cases with one case reference: one 201, one 409 lab_case_ref_in_use', async () => {
    const p = await createPatient(h, 'Synthetic Lab Race');
    const body = {
      patientRef: p,
      counterpartyRef: `syn-lab-${randomUUID().slice(0, 8)}`,
      caseRef: 'SYN-RACE-1',
    };
    const out = await raceInserts('clinical_lab_cases', [
      () => h.call('a1', 'POST', LAB, body, randomUUID()),
      () => h.call('a1', 'POST', LAB, body, randomUUID()),
    ]);
    expect(out.map((r) => r.statusCode).sort()).toStrictEqual([201, 409]);
    expect(reason(out.find((r) => r.statusCode === 409) as (typeof out)[number])).toStrictEqual([
      409,
      'lab_case_ref_in_use',
    ]);
  });

  it('two concurrent remakes naming one case reference: typed 409, never a 500', async () => {
    const p = await createPatient(h, 'Synthetic Remake Race');
    const lab = `syn-lab-${randomUUID().slice(0, 8)}`;
    const a = await newLabCase(p, lab);
    const b = h.ok<{ data: { labCaseRef: string } }>(
      await h.call(
        'a1',
        'POST',
        LAB,
        { patientRef: p, counterpartyRef: lab, caseRef: 'SYN-CASE-H15B' },
        randomUUID(),
      ),
      201,
    ).data.labCaseRef;
    for (const ref of [a, b]) {
      for (const [v, s] of [
        [1, 'sent'],
        [2, 'received'],
      ] as const) {
        const body =
          s === 'received'
            ? { expectedVersion: v, receivedDate: '2030-01-02', noAttachmentReason: 'paper_only' }
            : { expectedVersion: v, state: s };
        const path = s === 'received' ? 'return' : 'state';
        h.ok(await h.call('a1', 'POST', `${LAB}/${ref}/${path}`, body, randomUUID()), 200);
      }
    }
    const remake = (ref: string) => () =>
      h.call(
        'a1',
        'POST',
        `${LAB}/${ref}/remake`,
        { expectedVersion: 3, caseRef: 'SYN-REMAKE-RACE', reasonCode: 'shade_mismatch' },
        randomUUID(),
      );
    const out = await raceInserts('clinical_lab_cases', [remake(a), remake(b)]);
    expect(out.map((r) => r.statusCode).sort()).toStrictEqual([201, 409]);
    expect(reason(out.find((r) => r.statusCode === 409) as (typeof out)[number])).toStrictEqual([
      409,
      'lab_case_ref_in_use',
    ]);
  });

  it('two concurrent links of one image: one 201, one 409 naming the active link', async () => {
    const p = await createPatient(h, 'Synthetic Image Race');
    const enc = async () =>
      h.ok<{ data: { encounter: { encounterRef: string } } }>(
        await h.call('a1', 'POST', '/v1/clinical/encounters', { patientRef: p, locationRef: LOC }),
        201,
      ).data.encounter.encounterRef;
    const [e1, e2] = [await enc(), await enc()];
    const imageRef = `syn-img-${randomUUID()}`;
    images.put(T_ALPHA, imageRef, { status: 'current', patientRef: p, associationRef: 'syn-assoc-race' });
    const link = (e: string) => () =>
      h.call('a1', 'POST', `/v1/clinical/encounters/${e}/image-links`, { imageRef }, randomUUID());
    const out = await raceInserts('clinical_encounter_image_links', [link(e1), link(e2)]);
    expect(out.map((r) => r.statusCode).sort()).toStrictEqual([201, 409]);
    const refused = out.find((r) => r.statusCode === 409) as (typeof out)[number];
    expect(reason(refused)).toStrictEqual([409, 'image_linked_elsewhere']);
    const winner = out.find((r) => r.statusCode === 201) as (typeof out)[number];
    expect(refused.json().detail.blockingRefs).toStrictEqual([
      { kind: 'imageLink', ref: winner.json().data.imageLinkRef },
    ]);
  });

  it('two concurrent package preparations of one referral: one 200, one typed 409 (serialized by the row lock)', async () => {
    const p = await createPatient(h, 'Synthetic Referral Race');
    const r = await newOutgoingReferral(p);
    const version = h.ok<{ data: { plan: { headVersionRef: string } } }>(
      await h.call('a1', 'POST', '/v1/clinical/treatment-plans', { patientRef: p }, randomUUID()),
      201,
    ).data.plan.headVersionRef;
    const prepare = () =>
      h.call(
        'a1',
        'POST',
        `${REF}/${r}/package`,
        { expectedVersion: 1, selections: [{ kind: 'planVersion', ref: version }] },
        randomUUID(),
      );
    const out = await raceInserts('clinical_referral_selections', [prepare, prepare], 1);
    expect(out.map((x) => x.statusCode).sort()).toStrictEqual([200, 409]);
    expect(
      (
        await db.admin.query(
          'SELECT count(*)::int AS n FROM cuspatlas.clinical_referral_selections WHERE referral_id = $1',
          [r],
        )
      ).rows[0].n,
    ).toBe(1);
  });
});

describe('SHOULD e: lab case rows are authored by the acting human member', () => {
  it('a service principal cannot add a lab attachment or a transition directly', async () => {
    const p = await createPatient(h, 'Synthetic Lab Human');
    const c = await newLabCase(p);
    const attach: [string, unknown[]] = [
      `INSERT INTO cuspatlas.clinical_lab_case_attachments (tenant_id, case_id, attachment_ref, added_by)
       VALUES (cuspatlas.current_tenant_id(), $1, 'syn-obj-svc', cuspatlas.current_actor_id())`,
      [c],
    ];
    expect(await commit([attach], SVC_A1)).toBe('42501');
    expect(await commit([attach])).toBe('ok');
    const transition: [string, unknown[]] = [
      `INSERT INTO cuspatlas.clinical_lab_case_transitions (tenant_id, case_id, sequence, from_state, to_state,
         actor_id, actor_role)
       VALUES (cuspatlas.current_tenant_id(), $1, 2, 'draft', 'sent', cuspatlas.current_actor_id(), 'dentist')`,
      [c],
    ];
    expect(await commit([transition], SVC_A1)).toBe('42501');
  });
});

describe('SHOULD f: observation retention', () => {
  it('pruning removes rows of finished transactions only, and never affects the guards', async () => {
    const survivor = await createPatient(h, 'Synthetic Prune');
    const merged = await createPatient(h, 'Synthetic Prune');
    await newPlan(merged);
    const mergeRef = await mergePatients(h, survivor, merged);
    const before = (
      await db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.patient_reference_observations')
    ).rows[0].n as number;
    expect(before).toBeGreaterThan(0);
    // The runtime role cannot prune.
    expect(await commit([['SELECT cuspatlas.prune_patient_reference_observations()']])).toBe('42501');
    const pruned = (await db.admin.query('SELECT cuspatlas.prune_patient_reference_observations() AS n'))
      .rows[0].n as string;
    expect(Number(pruned)).toBe(before);
    expect(
      (await db.admin.query('SELECT count(*)::int AS n FROM cuspatlas.patient_reference_observations'))
        .rows[0].n,
    ).toBe(0);
    // Guards answer for the current transaction only: the real unmerge still passes after pruning.
    expect((await unmerge(mergeRef)).statusCode).toBe(200);
  });

  it('a prune running while a merge transaction is open leaves that transaction’s observations intact', async () => {
    const survivor = await createPatient(h, 'Synthetic Prune Open');
    const merged = await createPatient(h, 'Synthetic Prune Open');
    const plan = await newPlan(merged);
    const digest = (
      await db.admin.query(
        `SELECT encode(sha256(convert_to((to_jsonb(r) - 'subject_patient_id' - 'head_version' - 'version'
           - 'updated_at')::text, 'UTF8')), 'hex') AS d FROM cuspatlas.clinical_treatment_plans r WHERE id = $1`,
        [plan],
      )
    ).rows[0].d as string;
    const mergeId = randomUUID();
    const client = await db.app.connect();
    let outcome = 'ok';
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
      await client.query(`SELECT set_config('cuspatlas.actor_id', $1, true)`, [USER_A1]);
      await client.query(...relinkTo('clinical_treatment_plans', plan, survivor));
      await client.query(
        `INSERT INTO cuspatlas.patient_merges (id, tenant_id, survivor_patient_id, merged_patient_id,
           survivor_version_before, merged_version_before, survivor_digest, merged_digest, reason_code, move_count,
           merged_by)
         VALUES ($1, cuspatlas.current_tenant_id(), $2, $3, 1, 1, cuspatlas.patient_identity_digest($2),
           cuspatlas.patient_identity_digest($3), 'duplicate_registration', 1, cuspatlas.current_actor_id())`,
        [mergeId, survivor, merged],
      );
      await client.query(
        `INSERT INTO cuspatlas.patient_merge_moves (tenant_id, merge_id, record_class, record_ref, reference_column,
           prior_patient_id, new_patient_id, content_digest_before, content_digest_after)
         VALUES (cuspatlas.current_tenant_id(), $1, 'clinicalTreatmentPlan', $2, 'subject_patient_id', $3, $4, $5, $5)`,
        [mergeId, plan, merged, survivor, digest],
      );
      await client.query(
        'UPDATE cuspatlas.patients SET merged_into = $1, version = version + 1 WHERE id = $2',
        [survivor, merged],
      );
      await db.admin.query('SELECT cuspatlas.prune_patient_reference_observations()');
      await client.query('COMMIT');
    } catch (e) {
      outcome = (e as { code?: string }).code ?? 'error';
      await client.query('ROLLBACK').catch(() => undefined);
    } finally {
      client.release();
    }
    expect(outcome).toBe('ok');
    expect(await subjectOf('clinical_treatment_plans', plan)).toBe(survivor);
  });
});
