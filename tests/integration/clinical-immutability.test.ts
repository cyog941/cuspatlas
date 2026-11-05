import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  createPatient,
  mergePatients,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
} from './support/appointment-fixtures';
import { seedClinicalScopes, seedPerioConfiguration } from './support/clinical-fixtures';
import { buildClinicalRecord } from './support/clinical-record-fixture';
import { openTestDatabase, type TestDatabase } from './support/db';
import { seedPracticeFees } from './support/fee-fixtures';
import { fakeImageResolver } from './support/image-ref-resolver';
import { seedNoteScopes } from './support/note-fixtures';

/**
 * C18 immutability proof, consolidated: signed notes, posted (rendered) procedures and the
 * append-only chart, perio and history records (and every other append-only clinical fact) refuse
 * any rewrite or delete under the runtime role, and the role-independent guards refuse the owner too.
 * A merge and its unmerge never change content: every clinical record's content digest is identical
 * before the merge, after it and after the unmerge.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
const images = fakeImageResolver();
let rec: Awaited<ReturnType<typeof buildClinicalRecord>>;

beforeAll(async () => {
  db = await openTestDatabase('clinical_immutability');
  h = await openAppointmentHarness(db, { mcp: false, imageRefResolver: images });
  await seedClinicalScopes(db.admin);
  await seedPracticeFees(db, [['SYN-PROC-X01', 12_000]]);
  await seedNoteScopes(db.admin);
  await seedPerioConfiguration(db.admin, T_ALPHA);
  await db.admin.query(
    `INSERT INTO cuspatlas.clinical_referral_policies (tenant_id, disclosure_consent_template_ref)
     VALUES ($1, 'synthetic-disclosure-consent')`,
    [T_ALPHA],
  );
  loc = await seedLocation(h, 'loc-immutable');
  rec = await buildClinicalRecord(h, loc, images, 'Synthetic Immutable Record');
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

/** One statement in a runtime-role (or owner) transaction, rolled back; returns 'ok' or the SQLSTATE. */
async function attempt(sql: string, params: unknown[], role: 'runtime' | 'owner'): Promise<string> {
  const client = await (role === 'runtime' ? db.app : db.admin).connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
    const out = await client.query(sql, params).then(
      (r) => (r.rowCount === 0 ? 'no_rows' : 'ok'),
      (err: { code?: string }) => err.code ?? 'error',
    );
    await client.query('ROLLBACK');
    return out;
  } finally {
    client.release();
  }
}

/** [record class, table, the row filter, a content column and a new value]; filters bind $1. */
const CASES: readonly [string, string, string, string, string, () => string][] = [
  [
    'signed note version',
    'clinical_note_versions',
    'note_id',
    'content_digest',
    `'sha256:${'0'.repeat(64)}'`,
    () => rec.note,
  ],
  ['signed note header', 'clinical_notes', 'id', 'draft_sections', `'[]'::jsonb`, () => rec.note],
  ['rendered procedure', 'clinical_rendered_procedures', 'id', 'code_ref', `'SYN-PROC-ZZZ'`, () => rec.proc],
  [
    'procedure reversal',
    'clinical_rendered_procedures',
    'reverses_procedure_id',
    'reason_code',
    `'other_reason'`,
    () => rec.other,
  ],
  ['chart entry', 'clinical_chart_entries', 'id', 'finding_ref', `'SYN-COND-999'`, () => rec.entry],
  ['perio exam', 'clinical_perio_exams', 'id', 'tooth_count', '2', () => rec.perio],
  ['perio measurement', 'clinical_perio_measurements', 'exam_id', 'value_mm', '9', () => rec.perio],
  [
    'history version',
    'clinical_history_versions',
    'stream_id',
    'provenance',
    `'imported'`,
    () =>
      `(SELECT id FROM cuspatlas.clinical_history_streams WHERE subject_patient_id = '${rec.patientRef}')`,
  ],
  [
    'plan item event',
    'clinical_plan_item_events',
    'item_id',
    'reason_code',
    `'other_reason'`,
    () => rec.item,
  ],
  ['consent', 'clinical_consents', 'id', 'template_digest', `'sha256:${'1'.repeat(64)}'`, () => rec.consent],
  [
    'consent withdrawal',
    'clinical_consent_withdrawals',
    'consent_id',
    'reason_code',
    `'other_reason'`,
    () => rec.withdrawn,
  ],
  ['image link', 'clinical_encounter_image_links', 'id', 'image_ref', `'syn-img-other'`, () => rec.imageLink],
  [
    'lab case transition',
    'clinical_lab_case_transitions',
    'case_id',
    'to_state',
    `'cancelled'`,
    () => rec.lab,
  ],
  ['referral event', 'clinical_referral_events', 'referral_id', 'kind', `'closed'`, () => rec.referral],
  [
    'referral selection',
    'clinical_referral_selections',
    'referral_id',
    'record_kind',
    `'labCase'`,
    () => rec.referral,
  ],
];
const where = (col: string, value: string) =>
  value.startsWith('(') ? `${col} IN ${value}` : `${col} = '${value}'`;

describe('C18 immutability proof', () => {
  it.each(CASES.map((c) => [c[0], c] as const))(
    '%s: no rewrite and no delete under the runtime role',
    async (_n, c) => {
      const [, table, col, column, value, ref] = c;
      const update = await attempt(
        `UPDATE cuspatlas.${table} SET ${column} = ${value} WHERE ${where(col, ref())}`,
        [],
        'runtime',
      );
      const del = await attempt(`DELETE FROM cuspatlas.${table} WHERE ${where(col, ref())}`, [], 'runtime');
      expect([table, update, del]).toStrictEqual([table, '42501', '42501']);
    },
  );

  it.each(CASES.map((c) => [c[0], c] as const))(
    '%s: the owner path is refused by the row guard as well',
    async (_n, c) => {
      const [, table, col, column, value, ref] = c;
      const update = await attempt(
        `UPDATE cuspatlas.${table} SET ${column} = ${value} WHERE ${where(col, ref())}`,
        [],
        'owner',
      );
      const del = await attempt(`DELETE FROM cuspatlas.${table} WHERE ${where(col, ref())}`, [], 'owner');
      expect([table, update, del]).toStrictEqual([table, '42501', '42501']);
    },
  );

  it('the signed content still verifies through the domain after every attempt', async () => {
    const note = h.ok<{ data: { versions: { digestVerified: boolean }[] } }>(
      await h.call('a1', 'GET', `/v1/clinical/notes/${rec.note}`),
    ).data;
    expect(note.versions.map((v) => v.digestVerified)).toStrictEqual([true]);
  });
});

/** Content digest of every clinical row that references the patient's records (bookkeeping excluded). */
async function contentDigests(patientRef: string): Promise<Record<string, string>> {
  const { rows } = await db.admin.query<{ t: string; d: string }>(
    `WITH enc AS (SELECT DISTINCT encounter_id AS id FROM cuspatlas.clinical_rendered_procedures WHERE origin_patient_id = $1),
     x AS (
       SELECT 'encounters' AS t, to_jsonb(e) - ARRAY['subject_patient_id', 'version', 'updated_at'] AS j
         FROM cuspatlas.clinical_encounters e WHERE e.id IN (SELECT id FROM enc)
       UNION ALL SELECT 'procedures', to_jsonb(p) FROM cuspatlas.clinical_rendered_procedures p
         WHERE p.encounter_id IN (SELECT id FROM enc)
       UNION ALL SELECT 'notes', to_jsonb(n) - ARRAY['version', 'updated_at'] FROM cuspatlas.clinical_notes n
         WHERE n.encounter_id IN (SELECT id FROM enc)
       UNION ALL SELECT 'note_versions', to_jsonb(v) FROM cuspatlas.clinical_note_versions v
         WHERE v.note_id IN (SELECT id FROM cuspatlas.clinical_notes WHERE encounter_id IN (SELECT id FROM enc))
       UNION ALL SELECT 'chart_entries', to_jsonb(c) FROM cuspatlas.clinical_chart_entries c
         JOIN cuspatlas.clinical_charts ch ON ch.id = c.chart_id WHERE ch.origin_patient_id = $1
       UNION ALL SELECT 'perio', to_jsonb(m) FROM cuspatlas.clinical_perio_measurements m
         JOIN cuspatlas.clinical_perio_exams pe ON pe.id = m.exam_id
         JOIN cuspatlas.clinical_perio_streams ps ON ps.id = pe.stream_id WHERE ps.origin_patient_id = $1
       UNION ALL SELECT 'history', to_jsonb(hc) FROM cuspatlas.clinical_history_changes hc
         JOIN cuspatlas.clinical_history_items hi ON hi.id = hc.item_id
         JOIN cuspatlas.clinical_history_streams hs ON hs.id = hi.stream_id WHERE hs.origin_patient_id = $1
       UNION ALL SELECT 'plan_items', to_jsonb(i) FROM cuspatlas.clinical_plan_items i
         JOIN cuspatlas.clinical_plan_versions pv ON pv.id = i.plan_version_id
         JOIN cuspatlas.clinical_treatment_plans tp ON tp.id = pv.plan_id WHERE tp.origin_patient_id = $1
       UNION ALL SELECT 'consents', to_jsonb(c) - ARRAY['subject_patient_id', 'version', 'updated_at']
         FROM cuspatlas.clinical_consents c WHERE c.origin_patient_id = $1
       UNION ALL SELECT 'image_links', to_jsonb(k) FROM cuspatlas.clinical_encounter_image_links k
         WHERE k.encounter_id IN (SELECT id FROM enc)
       UNION ALL SELECT 'lab_cases', to_jsonb(l) - ARRAY['subject_patient_id', 'version', 'updated_at']
         FROM cuspatlas.clinical_lab_cases l WHERE l.origin_patient_id = $1
       UNION ALL SELECT 'referrals', to_jsonb(r) - ARRAY['subject_patient_id', 'version', 'updated_at']
         FROM cuspatlas.clinical_referrals r WHERE r.origin_patient_id = $1
     )
     SELECT t, encode(sha256(convert_to(string_agg(j::text, '|' ORDER BY j::text), 'UTF8')), 'hex') AS d
     FROM x GROUP BY t ORDER BY t`,
    [patientRef],
  );
  return Object.fromEntries(rows.map((r) => [r.t, r.d]));
}

describe('C18: a merge never changes clinical content', () => {
  it('content digests are identical before a merge, after it and after the unmerge', async () => {
    const survivor = await createPatient(h, 'Synthetic Immutable Merge');
    const merged = await createPatient(h, 'Synthetic Immutable Merge');
    await buildClinicalRecord(h, loc, images, 'Synthetic Immutable Merge', merged);
    const before = await contentDigests(merged);
    expect(Object.keys(before).sort()).toStrictEqual(
      [
        'chart_entries',
        'consents',
        'encounters',
        'history',
        'image_links',
        'lab_cases',
        'note_versions',
        'notes',
        'perio',
        'plan_items',
        'procedures',
        'referrals',
      ].sort(),
    );
    const mergeRef = await mergePatients(h, survivor, merged);
    expect(await contentDigests(merged)).toStrictEqual(before);
    const back = await h.call('a1', 'POST', `/v1/patients/merges/${mergeRef}/unmerge`, {
      reasonCode: 'merged_in_error',
    });
    expect(back.statusCode).toBe(200);
    expect(await contentDigests(merged)).toStrictEqual(before);
  });
});
