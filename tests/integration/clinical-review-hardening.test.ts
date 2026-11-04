import { randomUUID } from 'node:crypto';
import { createTenantTransactionRunner } from '@cuspatlas/db';
import { MERGE_RECORD_CLASSES, NOTE_POST_MERGE_FACT_PROBE } from '@cuspatlas/domain';
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
import { ctxFor, USER_A3 } from './support/fixtures';
import { seedNoteScopes, USER_A9 } from './support/note-fixtures';

/**
 * Hardening of C6-C11 and of the S6 merge rows after the independent review of c-chart 0b72f27 and
 * c-notes 99ba582. Every direct write runs under the runtime role `cuspatlas_app` with tenant and
 * actor context, exactly as the application does, and commits so deferred checks run.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let a9: string;
const PLANS = '/v1/clinical/treatment-plans';
const LOC = 'loc-north';

beforeAll(async () => {
  db = await openTestDatabase('clinical_review_hardening');
  h = await openAppointmentHarness(db, { mcp: false });
  await seedClinicalScopes(db.admin);
  await seedNoteScopes(db.admin);
  loc = await seedLocation(h, LOC);
  a9 = await h.issuer.issue({ sub: USER_A9, tid: T_ALPHA });
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

const planOf = async (patientRef: string) =>
  h.ok<{ data: { plan: { planRef: string; headVersionRef: string } } }>(
    await h.call('a1', 'POST', PLANS, { patientRef }, randomUUID()),
    201,
  ).data.plan;
const digestOf = async (table: string, id: string, exclude: string[]) =>
  (
    await db.admin.query(
      `SELECT encode(sha256(convert_to((to_jsonb(r) ${exclude.map((c) => `- '${c}'`).join(' ')})::text, 'UTF8')), 'hex') AS d
       FROM cuspatlas.${table} r WHERE id = $1`,
      [id],
    )
  ).rows[0].d as string;
const PLAN_EXCLUDE = ['subject_patient_id', 'head_version', 'version', 'updated_at'];

describe('REQUIRED: merge rows cannot be forged to relink clinical records', () => {
  it('the database record-class registry agrees with MERGE_RECORD_CLASSES (regression pin)', async () => {
    for (const cls of MERGE_RECORD_CLASSES) {
      const { rows } = await db.admin.query(
        'SELECT cuspatlas.merge_class_table($1) AS t, cuspatlas.merge_class_digest_exclude($1) AS x',
        [cls.recordClass],
      );
      expect([cls.recordClass, rows[0].t, [...rows[0].x].sort()]).toStrictEqual([
        cls.recordClass,
        cls.table,
        [...cls.digestExclude].sort(),
      ]);
    }
  });

  it('a forged merge and move with a relink in one runtime-role transaction is refused at commit', async () => {
    const a = await createPatient(h, 'Synthetic Forge Source');
    const b = await createPatient(h, 'Synthetic Forge Target');
    const plan = await planOf(a);
    const d = await digestOf('clinical_treatment_plans', plan.planRef, PLAN_EXCLUDE);
    const mergeId = randomUUID();
    const forged: [string, unknown[]][] = [
      [
        `INSERT INTO cuspatlas.patient_merges (id, tenant_id, survivor_patient_id, merged_patient_id, survivor_version_before,
           merged_version_before, survivor_digest, merged_digest, reason_code, move_count, merged_by)
         VALUES ($1, cuspatlas.current_tenant_id(), $2, $3, 1, 1, repeat('0', 64), repeat('0', 64), 'duplicate_registration',
           1, cuspatlas.current_actor_id())`,
        [mergeId, b, a],
      ],
      [
        `INSERT INTO cuspatlas.patient_merge_moves (tenant_id, merge_id, record_class, record_ref, reference_column,
           prior_patient_id, new_patient_id, content_digest_before, content_digest_after)
         VALUES (cuspatlas.current_tenant_id(), $1, 'clinicalTreatmentPlan', $2, 'subject_patient_id', $3, $4, $5, $5)`,
        [mergeId, plan.planRef, a, b, d],
      ],
      [
        'UPDATE cuspatlas.clinical_treatment_plans SET subject_patient_id = $1, version = version + 1 WHERE id = $2',
        [b, plan.planRef],
      ],
    ];
    expect(await commit(forged)).toBe('42501');
    // Marking the patient merged as well does not help: the caller-supplied identity digests are checked.
    const withPatient: [string, unknown[]][] = [
      ...forged,
      ['UPDATE cuspatlas.patients SET merged_into = $1, version = version + 1 WHERE id = $2', [b, a]],
    ];
    expect(await commit(withPatient)).toBe('42501');
    const plans = await db.admin.query(
      'SELECT subject_patient_id FROM cuspatlas.clinical_treatment_plans WHERE id = $1',
      [plan.planRef],
    );
    expect(plans.rows[0].subject_patient_id).toBe(a);
  });

  it('a forged reversal of a real merge with a relink back is refused at commit', async () => {
    const survivor = await createPatient(h, 'Synthetic Forge Reversal');
    const merged = await createPatient(h, 'Synthetic Forge Reversal');
    const plan = await planOf(merged);
    // A survivor record that exists before the merge (a post-merge record would require the review).
    const other = await planOf(survivor);
    const mergeRef = await mergePatients(h, survivor, merged);
    const forged: [string, unknown[]][] = [
      [
        `INSERT INTO cuspatlas.patient_merge_reversals (tenant_id, merge_id, reason_code, elevated, move_count, reversed_by)
         VALUES (cuspatlas.current_tenant_id(), $1, 'merged_in_error', false, 1, cuspatlas.current_actor_id())`,
        [mergeRef],
      ],
      [
        'UPDATE cuspatlas.clinical_treatment_plans SET subject_patient_id = $1, version = version + 1 WHERE id = $2',
        [merged, plan.planRef],
      ],
    ];
    expect(await commit(forged)).toBe('42501');
    // A forged move appended to the real merge in a later transaction is refused too.
    const d = await digestOf('clinical_treatment_plans', other.planRef, PLAN_EXCLUDE);
    expect(
      await commit([
        [
          `INSERT INTO cuspatlas.patient_merge_moves (tenant_id, merge_id, record_class, record_ref, reference_column,
             prior_patient_id, new_patient_id, content_digest_before, content_digest_after)
           VALUES (cuspatlas.current_tenant_id(), $1, 'clinicalTreatmentPlan', $2, 'subject_patient_id', $3, $4, $5, $5)`,
          [mergeRef, other.planRef, merged, survivor, d],
        ],
      ]),
    ).toBe('42501');
    // The real merge and its real unmerge still work.
    const back = await h.call('a1', 'POST', `/v1/patients/merges/${mergeRef}/unmerge`, {
      reasonCode: 'merged_in_error',
    });
    expect(back.statusCode).toBe(200);
    const after = await db.admin.query(
      'SELECT subject_patient_id FROM cuspatlas.clinical_treatment_plans WHERE id = $1',
      [plan.planRef],
    );
    expect(after.rows[0].subject_patient_id).toBe(merged);
  });
});

type Note = {
  noteRef: string;
  version: number;
  versions: { sequence: number; contentDigest: string; digestVerified: boolean }[];
};
const CONTENT = {
  sections: [{ sectionKey: 'subjective', text: 'Synthetic complaint' }],
  procedureCodeRefs: [],
};
async function encounter(supervised = false) {
  const p = await createPatient(h, 'Synthetic Hardening Note');
  const e = h.ok<{ data: { encounter: { encounterRef: string; version: number } } }>(
    await h.call('a1', 'POST', '/v1/clinical/encounters', { patientRef: p, locationRef: LOC }),
    201,
  ).data.encounter;
  if (supervised) {
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/encounters/${e.encounterRef}/assignments`, {
        expectedVersion: e.version,
        role: 'supervising_provider',
        assignee: { kind: 'provider', resourceRef: loc.provider },
      }),
      201,
    );
  }
  return { patientRef: p, encounterRef: e.encounterRef };
}
const draft = async (encounterRef: string, who = 'a1') =>
  h.ok<{ data: Note }>(
    await h.call(
      who,
      'POST',
      `/v1/clinical/encounters/${encounterRef}/notes`,
      { noteType: 'progress', content: CONTENT },
      randomUUID(),
    ),
    201,
  ).data;
const post = (noteRef: string, action: string, body: unknown, who = 'a1') =>
  h.call(who, 'POST', `/v1/clinical/notes/${noteRef}/${action}`, body, randomUUID());
const sign = async (n: Note, who = 'a1') =>
  h.ok<{ data: Note }>(await post(n.noteRef, 'sign', { expectedVersion: n.version }, who)).data;
async function attempts(correlationId: string): Promise<string[]> {
  const { rows } = await db.admin.query(
    'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
    [correlationId],
  );
  return rows.map((r) => r.reason_code);
}
const ADDENDUM = (noteRef: string, sequence: number, role = 'dentist', cosign = false) =>
  [
    `INSERT INTO cuspatlas.clinical_note_versions (tenant_id, note_id, sequence, kind, references_sequence, reason_code,
       addendum_text, history_refs, authored_by, authored_by_role, authored_by_credential_ref, authored_at,
       cosign_required, content_digest)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, 'addendum', 1, 'clarification', 'Synthetic addendum', '[]'::jsonb,
       cuspatlas.current_actor_id(), $3, 'SYN-CRED-A1', now(), $4, 'sha256:' || repeat('0', 64))`,
    [noteRef, sequence, role, cosign],
  ] as [string, unknown[]];
const BUMP = (noteRef: string): [string, unknown[]] => [
  'UPDATE cuspatlas.clinical_notes SET head_sequence = head_sequence + 1, version = version + 1 WHERE id = $1',
  [noteRef],
];

describe('SHOULD: note insert-side integrity, co-signature, merge probe and tamper detection', () => {
  it('note versions, headers and drafts are tied together and to the actor by the database', async () => {
    const e = await encounter();
    const d = await draft(e.encounterRef);
    // Another clinician cannot be named as the draft's updater.
    expect(
      await commit([
        [
          `UPDATE cuspatlas.clinical_notes SET draft_sections = '[]'::jsonb, draft_updated_by = $2, version = version + 1
           WHERE id = $1`,
          [d.noteRef, USER_A3],
        ],
      ]),
    ).toBe('42501');
    // A header cannot become signed without its frozen original.
    expect(
      await commit([
        [
          `UPDATE cuspatlas.clinical_notes SET state = 'signed', head_sequence = 1, version = version + 1 WHERE id = $1`,
          [d.noteRef],
        ],
      ]),
    ).toBe('42501');
    const s = await sign(d);
    // A version that the header does not count is refused at commit; so is a wrong author snapshot.
    expect(await commit([ADDENDUM(s.noteRef, 2)])).toBe('42501');
    expect(await commit([ADDENDUM(s.noteRef, 2, 'hygienist'), BUMP(s.noteRef)])).toBe('42501');
    // The co-signature requirement is derived from the encounter, never chosen by the writer.
    const sup = await encounter(true);
    const s2 = await sign(await draft(sup.encounterRef));
    expect(await commit([ADDENDUM(s2.noteRef, 2, 'dentist', false), BUMP(s2.noteRef)])).toBe('42501');
    // The well-formed write path still commits.
    expect(await commit([ADDENDUM(s.noteRef, 2), BUMP(s.noteRef)])).toBe('ok');
  });

  it('the original signer cannot co-sign a later version of the same note', async () => {
    const e = await encounter(true);
    const s = await sign(await draft(e.encounterRef, 'a3'), 'a3');
    const amended = h.ok<{ data: Note }>(
      await post(
        s.noteRef,
        'amendments',
        { expectedVersion: s.version, reasonCode: 'correction', content: CONTENT },
        a9,
      ),
      201,
    ).data;
    const v2 = amended.versions.find((v) => v.sequence === 2);
    const res = await post(
      s.noteRef,
      'cosignatures',
      { sequence: 2, contentDigest: v2?.contentDigest },
      'a3',
    );
    expect([res.statusCode, res.json().detail?.reason]).toStrictEqual([409, 'cosigner_is_signer']);
  });

  it('the note merge probe counts facts at the merge instant and draft updates', async () => {
    const e = await encounter();
    const d = await draft(e.encounterRef);
    const { rows } = await db.admin.query(
      'SELECT draft_updated_at FROM cuspatlas.clinical_notes WHERE id = $1',
      [d.noteRef],
    );
    const n = await createTenantTransactionRunner(db.app)(ctxFor(T_ALPHA, USER_A1, 'human'), (tx) =>
      NOTE_POST_MERGE_FACT_PROBE.count(tx, e.patientRef, rows[0].draft_updated_at),
    );
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('a tampered frozen version is detected on read with an alert row, and amending it is refused', async () => {
    const e = await encounter();
    const s = await sign(await draft(e.encounterRef));
    await db.admin.query(
      'ALTER TABLE cuspatlas.clinical_note_versions DISABLE TRIGGER clinical_note_versions_append_only',
    );
    try {
      await db.admin.query(
        `UPDATE cuspatlas.clinical_note_versions SET sections = '[{"sectionKey":"subjective","text":"Synthetic altered"}]'::jsonb
         WHERE note_id = $1`,
        [s.noteRef],
      );
    } finally {
      await db.admin.query(
        'ALTER TABLE cuspatlas.clinical_note_versions ENABLE TRIGGER clinical_note_versions_append_only',
      );
    }
    const read = await h.call('a1', 'GET', `/v1/clinical/notes/${s.noteRef}`);
    expect(read.json().data.versions[0].digestVerified).toBe(false);
    expect(await attempts(read.headers['x-correlation-id'] as string)).toStrictEqual([
      'clinical_note_tampered',
    ]);
    const amend = await post(s.noteRef, 'amendments', {
      expectedVersion: s.version,
      reasonCode: 'correction',
      content: CONTENT,
    });
    expect([amend.statusCode, amend.json().detail?.reason]).toStrictEqual([409, 'note_integrity_failed']);
    expect(await attempts(amend.headers['x-correlation-id'] as string)).toStrictEqual([
      'clinical_note_tampered',
    ]);
  });
});

async function itemPlan(name: string) {
  const patientRef = await createPatient(h, name);
  const plan = await planOf(patientRef);
  const v = plan.headVersionRef;
  const detail = h.ok<{ data: { targetRef: string } }>(
    await h.call('a1', 'POST', `${PLANS}/versions/${v}/details`, {
      expectedRevision: 1,
      scope: 'whole_mouth',
    }),
    201,
  ).data.targetRef;
  const item = h.ok<{ data: { targetRef: string } }>(
    await h.call('a1', 'POST', `${PLANS}/details/${detail}/items`, {
      expectedRevision: 2,
      procedureCodeRef: 'SYN-PROC-400',
      sequence: 1,
    }),
    201,
  ).data.targetRef;
  return { patientRef, planRef: plan.planRef, versionRef: v, detail, item };
}
const ITEM = (detail: string, version: string, derivedFrom: string | null = null): [string, unknown[]] => [
  `INSERT INTO cuspatlas.clinical_plan_items (id, tenant_id, detail_id, plan_version_id, sequence, procedure_code_ref,
     derived_from_item_id, created_by, created_by_role, created_by_credential_ref)
   VALUES ($4, cuspatlas.current_tenant_id(), $1, $2, 50, 'SYN-PROC-450', $3, cuspatlas.current_actor_id(), 'dentist',
     'SYN-CRED-A1')`,
  [detail, version, derivedFrom, randomUUID()],
];
const EVENT = (
  item: string,
  sequence: number,
  from: string | null,
  to: string,
  cause: string,
  appointment: string | null = null,
) =>
  [
    `INSERT INTO cuspatlas.clinical_plan_item_events (tenant_id, item_id, sequence, from_state, to_state, cause,
       appointment_id, recorded_by, recorded_by_role, recorded_by_credential_ref)
     VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, $5, $6, cuspatlas.current_actor_id(), 'dentist', 'SYN-CRED-A1')`,
    [item, sequence, from, to, cause, appointment],
  ] as [string, unknown[]];

describe('SHOULD: plan database backing and placement', () => {
  it('a carried-forward item must carry its source item’s state', async () => {
    const f = await itemPlan('Synthetic Carry Forward');
    const next = h.ok<{
      data: {
        targetRef: string;
        plan: { versions: { planVersionRef: string; details: { detailRef: string }[] }[] };
      };
    }>(
      await h.call('a1', 'POST', `${PLANS}/versions/${f.versionRef}/supersede`, {
        expectedRevision: 3,
        reasonCode: 'treatment_changed',
      }),
      201,
    ).data;
    const v2 = next.plan.versions.find((v) => v.planVersionRef === next.targetRef);
    const d2 = v2?.details[0]?.detailRef as string;
    const insert = ITEM(d2, next.targetRef, f.item);
    const id = insert[1][3] as string;
    expect(await commit([insert, EVENT(id, 1, null, 'accepted', 'carried_forward')])).toBe('42501');
    const valid = ITEM(d2, next.targetRef, f.item);
    expect(await commit([valid, EVENT(valid[1][3] as string, 1, null, 'proposed', 'carried_forward')])).toBe(
      'ok',
    );
  });

  it('a declined detail takes no new item and no direct transition', async () => {
    const f = await itemPlan('Synthetic Declined Detail');
    h.ok(
      await h.call('a1', 'POST', `${PLANS}/details/${f.detail}/state`, {
        expectedRevision: 3,
        state: 'declined',
        reasonCode: 'patient_declined',
      }),
    );
    expect(await commit([ITEM(f.detail, f.versionRef)])).toBe('42501');
    expect(await commit([EVENT(f.item, 3, 'declined', 'proposed', 'direct')])).toBe('42501');
  });

  it('scheduling an item needs an appointment of the plan’s own patient', async () => {
    const f = await itemPlan('Synthetic Schedule Owner');
    h.ok(
      await h.call('a1', 'POST', `${PLANS}/items/${f.item}/state`, {
        expectedRevision: 3,
        state: 'accepted',
      }),
    );
    const other = await createPatient(h, 'Synthetic Schedule Other');
    const appt = h.ok<{ data: { appointmentRef: string } }>(
      await h.call('a1', 'POST', '/v1/scheduling/appointments', {
        patientRef: other,
        locationRef: loc.locationRef,
        startsAt: '2030-02-04T14:00:00Z',
        endsAt: '2030-02-04T14:30:00Z',
        timeZone: 'America/New_York',
        provider: { kind: 'provider', resourceRef: loc.provider },
        operatory: { kind: 'operatory', resourceRef: loc.operatory },
      }),
      201,
    ).data.appointmentRef;
    expect(
      await commit([
        EVENT(f.item, 3, 'accepted', 'scheduled', 'direct', appt),
        ['UPDATE cuspatlas.clinical_plan_versions SET revision = revision + 1 WHERE id = $1', [f.versionRef]],
      ]),
    ).toBe('42501');
  });

  it('surfaces must fit the tooth class; a supernumerary tooth takes none', async () => {
    const f = await itemPlan('Synthetic Surface Class');
    const detail = (tooth: string, surfaces: string[]): [string, unknown[]] => [
      `INSERT INTO cuspatlas.clinical_plan_details (tenant_id, plan_version_id, sequence, scope, tooth_canonical_ref,
         tooth_vocabulary, surfaces, created_by, created_by_role, created_by_credential_ref)
       VALUES (cuspatlas.current_tenant_id(), $1, $2, 'surface_set', $3, 'cuspatlas-tooth.v1', $4::text[],
         cuspatlas.current_actor_id(), 'dentist', 'SYN-CRED-A1')`,
      [f.versionRef, 40 + surfaces.length, tooth, surfaces],
    ];
    expect(await commit([detail('sn-ur-1', ['M'])])).toBe('23514');
    expect(await commit([detail('perm-ur-1', ['O'])])).toBe('23514');
    expect(await commit([detail('perm-ur-6', ['I'])])).toBe('23514');
  });

  it('planning on a tooth charted missing needs the missing-tooth entry itself', async () => {
    const p = await createPatient(h, 'Synthetic Missing Placement');
    const chart = async (kind: string, findingRef?: string) =>
      h.ok<{ data: { entry: { entryRef: string } } }>(
        await h.call('a1', 'POST', '/v1/clinical/chart/entries', {
          patientRef: p,
          provenance: 'recorded',
          tooth: { system: 'universal', code: '3' },
          kind,
          ...(findingRef ? { findingRef } : {}),
        }),
        201,
      ).data.entry.entryRef;
    const condition = await chart('condition', 'SYN-COND-500');
    const missing = await chart('missing', 'SYN-MISS-500');
    const plan = await planOf(p);
    const viaCondition = await h.call('a1', 'POST', `${PLANS}/versions/${plan.headVersionRef}/details`, {
      expectedRevision: 1,
      scope: 'tooth',
      tooth: { system: 'universal', code: '3' },
      chartEntryRef: condition,
    });
    expect([viaCondition.statusCode, viaCondition.json().detail?.reason]).toStrictEqual([
      409,
      'tooth_absent_on_chart',
    ]);
    const viaMissing = await h.call('a1', 'POST', `${PLANS}/versions/${plan.headVersionRef}/details`, {
      expectedRevision: 1,
      scope: 'tooth',
      tooth: { system: 'universal', code: '3' },
      chartEntryRef: missing,
    });
    expect(viaMissing.statusCode).toBe(201);
  });
});
