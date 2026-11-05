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
import { openTestDatabase, type TestDatabase } from './support/db';

/**
 * Integration hardening: the S-owned patient references registered in the merge registry have the
 * database relink guard C records have (migration 20261125010000). Every forged write runs under the
 * runtime role `cuspatlas_app` with tenant and actor context, exactly as the application does, and
 * commits so the deferred checks run. Real merges and unmerges (S6 through the API) still relink.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let slot = 0;

beforeAll(async () => {
  db = await openTestDatabase('s_relink_guard');
  h = await openAppointmentHarness(db, { mcp: false });
  loc = await seedLocation(h, 'loc-s-relink');
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

async function commit(statements: readonly [string, unknown[]?][]): Promise<string> {
  const client = await db.app.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
    await client.query(`SELECT set_config('cuspatlas.actor_id', $1, true)`, [USER_A1]);
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
const refOf = async (table: string, column: string, id: string) =>
  (await db.admin.query(`SELECT ${column} AS p FROM cuspatlas.${table} WHERE id = $1`, [id])).rows[0]
    .p as string;
const relink = (table: string, column: string, id: string, patient: string): [string, unknown[]] => [
  `UPDATE cuspatlas.${table} SET ${column} = $1, version = version + 1, updated_at = now() WHERE id = $2`,
  [patient, id],
];
const unmerge = (mergeRef: string) =>
  h.call('a1', 'POST', `/v1/patients/merges/${mergeRef}/unmerge`, { reasonCode: 'merged_in_error' });
const window = () => {
  const day = 1 + Math.floor(slot / 8);
  const hour = 13 + (slot % 8);
  slot += 1;
  const at = (hh: number) => new Date(Date.UTC(2031, 0, day, hh)).toISOString();
  return {
    startsAt: at(hour),
    endsAt: at(hour + 1),
    timeZone: 'America/New_York',
    provider: { kind: 'provider', resourceRef: loc.provider },
    operatory: { kind: 'operatory', resourceRef: loc.operatory },
  };
};
const only = async (table: string, column: string, patient: string) =>
  (await db.admin.query(`SELECT id FROM cuspatlas.${table} WHERE ${column} = $1`, [patient])).rows[0]
    .id as string;

/** Record makers: each creates one S record whose `column` names `patient`, through the API. */
const makers: Record<string, { table: string; column: string; make: (patient: string) => Promise<string> }> =
  {
    appointment: {
      table: 'appointments',
      column: 'subject_patient_id',
      make: async (patient) =>
        h.ok<{ data: { appointmentRef: string } }>(
          await h.call('a1', 'POST', '/v1/scheduling/appointments', {
            patientRef: patient,
            locationRef: loc.locationRef,
            ...window(),
          }),
          201,
        ).data.appointmentRef,
    },
    appointmentRequest: {
      table: 'appointment_requests',
      column: 'subject_patient_id',
      make: async (patient) =>
        h.ok<{ data: { requestRef: string } }>(
          await h.call('a1', 'POST', '/v1/scheduling/appointment-requests', {
            patientRef: patient,
            locationRef: loc.locationRef,
            sourceChannel: 'phone',
            contactConsent: 'unknown',
            flexibility: 'mornings',
          }),
          201,
        ).data.requestRef,
    },
    appointmentSeries: {
      table: 'appointment_series',
      column: 'subject_patient_id',
      make: async (patient) => {
        slot += 8;
        const day = 1 + Math.floor(slot / 8);
        h.ok(
          await h.call('a1', 'POST', '/v1/scheduling/series', {
            patientRef: patient,
            locationRef: loc.locationRef,
            provider: { kind: 'provider', resourceRef: loc.provider },
            operatory: { kind: 'operatory', resourceRef: loc.operatory },
            pattern: { frequency: 'weekly', interval: 1 },
            firstDate: `2032-0${1 + (day % 9)}-1${day % 10}`,
            startTime: '11:00',
            durationMinutes: 30,
            count: 2,
          }),
          201,
        );
        return only('appointment_series', 'subject_patient_id', patient);
      },
    },
    waitlistEntry: {
      table: 'waitlist_entries',
      column: 'subject_patient_id',
      make: async (patient) =>
        h.ok<{ data: { entryRef: string } }>(
          await h.call('a1', 'POST', '/v1/scheduling/waitlist', {
            patientRef: patient,
            locationRef: loc.locationRef,
            durationMinutes: 60,
            desiredFrom: '2031-01-01T00:00:00Z',
            desiredUntil: '2031-12-31T00:00:00Z',
          }),
          201,
        ).data.entryRef,
    },
    relationshipSubject: {
      table: 'patient_relationships',
      column: 'subject_patient_id',
      make: async (patient) => {
        const other = await createPatient(h, 'Synthetic Relink Counterparty');
        h.ok(
          await h.call('a1', 'POST', `/v1/patients/${patient}/relationships`, {
            counterpartyRef: other,
            kind: 'guarantor',
            scopes: ['financial'],
          }),
          201,
        );
        return only('patient_relationships', 'subject_patient_id', patient);
      },
    },
    relationshipCounterparty: {
      table: 'patient_relationships',
      column: 'counterparty_patient_id',
      make: async (patient) => {
        const subject = await createPatient(h, 'Synthetic Relink Subject');
        h.ok(
          await h.call('a1', 'POST', `/v1/patients/${subject}/relationships`, {
            counterpartyRef: patient,
            kind: 'guarantor',
            scopes: ['financial'],
          }),
          201,
        );
        return only('patient_relationships', 'counterparty_patient_id', patient);
      },
    },
  };

describe('S relink guard (every S record class of the merge registry)', () => {
  for (const [name, { table, column, make }] of Object.entries(makers)) {
    it(`${name}: a bare relink is refused; a real merge and unmerge relink; a stale reversal is refused`, async () => {
      const survivor = await createPatient(h, `Synthetic Relink ${name}`);
      const merged = await createPatient(h, `Synthetic Relink ${name}`);
      const stranger = await createPatient(h, `Synthetic Relink Stranger ${name}`);
      const record = await make(merged);
      // Outside any merge: to the would-be survivor or to an unrelated patient.
      expect(await commit([relink(table, column, record, survivor)])).toBe('42501');
      expect(await commit([relink(table, column, record, stranger)])).toBe('42501');
      expect(await refOf(table, column, record)).toBe(merged);
      const m1 = await mergePatients(h, survivor, merged);
      expect(await refOf(table, column, record)).toBe(survivor);
      // After the merge, a bare move back (no reversal in this transaction) is refused.
      expect(await commit([relink(table, column, record, merged)])).toBe('42501');
      expect((await unmerge(m1)).statusCode).toBe(200);
      expect(await refOf(table, column, record)).toBe(merged);
      // m1's reversal does not license a later bare relink after a second merge.
      const m2 = await mergePatients(h, survivor, merged);
      expect(await refOf(table, column, record)).toBe(survivor);
      expect(await commit([relink(table, column, record, merged)])).toBe('42501');
      expect((await unmerge(m2)).statusCode).toBe(200);
      expect(await refOf(table, column, record)).toBe(merged);
    });
  }

  it('the guard covers exactly the S record classes of the registry', async () => {
    const { rows } = await db.admin.query<{ t: string; trigger: string }>(
      `SELECT c.relname AS t, tg.tgname AS trigger FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
       JOIN pg_proc p ON p.oid = tg.tgfoid WHERE p.proname = 'merge_reference_relink_guard' ORDER BY 1, 2`,
    );
    expect(rows.map((r) => r.trigger)).toStrictEqual([
      'appointment_requests_relink',
      'appointment_series_relink',
      'appointments_relink',
      'patient_relationships_counterparty_relink',
      'patient_relationships_subject_relink',
      'waitlist_entries_relink',
    ]);
  });

  it('recall tasks are excluded from merges: their patient never moves under the runtime role', async () => {
    const a = await createPatient(h, 'Synthetic Recall Relink');
    const b = await createPatient(h, 'Synthetic Recall Relink');
    const appt = h.ok<{ data: { appointmentRef: string } }>(
      await h.call('a1', 'POST', '/v1/scheduling/appointments', {
        patientRef: a,
        locationRef: loc.locationRef,
        ...window(),
      }),
      201,
    ).data.appointmentRef;
    h.ok(
      await h.call('a1', 'POST', `/v1/scheduling/appointments/${appt}/attendance`, { kind: 'arrived' }),
      201,
    );
    const policy = h.ok<{ data: { version: number } }>(
      await h.call('a1', 'POST', '/v1/scheduling/recall/policies', {
        category: 's-relink',
        intervalMonths: 6,
        basis: 'attended_visit',
      }),
      201,
    ).data;
    const task = h.ok<{ data: { recallTaskRef: string } }>(
      await h.call('a1', 'POST', '/v1/scheduling/recall/tasks', {
        patientRef: a,
        category: 's-relink',
        locationRef: loc.locationRef,
        expectedPolicyVersion: policy.version,
        asOf: '2031-12-01T12:00:00Z',
      }),
      201,
    ).data.recallTaskRef;
    expect(await commit([relink('recall_tasks', 'subject_patient_id', task, b)])).toBe('42501');
    // A real merge leaves the task with its identity (excluded reference) and passes.
    await mergePatients(h, b, a);
    expect(await refOf('recall_tasks', 'subject_patient_id', task)).toBe(a);
  });
});
