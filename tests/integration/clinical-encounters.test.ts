import { randomUUID } from 'node:crypto';
import {
  validateEncounterList,
  validateEncounterOpenResult,
  validateEncounterRead,
} from '@cuspatlas/contracts';
import { MERGE_RECORD_CLASSES } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { seedClinicalScopes, seedDispositions, USER_A7 } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { MARKER } from './support/marker';

/**
 * C5: encounters and clinical authorship (synthetic engineering implementation; clinical semantics
 * recommended-pending-clinical-approval). An encounter is a separate fact from the booking, from
 * attendance (S11), from procedure completion (C14) and from billing (B1). Every denial runs under
 * the runtime role.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let loc: { locationRef: string; provider: string; operatory: string };
let provider2: string;
let staff: string;
let a7: string;
const APPT = '/v1/scheduling/appointments';
const ENC = '/v1/clinical/encounters';
let slot = 0;

beforeAll(async () => {
  db = await openTestDatabase('clinical_encounters');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedClinicalScopes(db.admin);
  await seedDispositions(db.admin, T_ALPHA, ['completed_as_planned', 'patient_left']);
  loc = await seedLocation(h, 'loc-clinic');
  await seedLocation(h, 'loc-north');
  const define = async (kind: string, label: string) =>
    h.ok<{ data: { resourceRef: string } }>(
      await h.call('a1', 'POST', '/v1/scheduling/resources', {
        kind,
        locationRef: loc.locationRef,
        displayLabel: label,
      }),
      201,
    ).data.resourceRef;
  provider2 = await define('provider', 'Synthetic Provider Two');
  staff = await define('staff', 'Synthetic Assistant');
  a7 = await h.issuer.issue({ sub: USER_A7, tid: T_ALPHA });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

/** Books a fresh synthetic appointment (a new patient unless one is given). */
async function appointment(patient?: string): Promise<{ appointmentRef: string; patientRef: string }> {
  const patientRef = patient ?? (await createPatient(h, 'Synthetic Clinical'));
  const hour = 13 + (slot % 8);
  const day = 2 + Math.floor(slot / 8) * 7;
  slot += 1;
  const at = (hh: number) => new Date(Date.UTC(2030, 4, day, hh)).toISOString();
  const res = h.ok<{ data: { appointmentRef: string } }>(
    await h.call('a1', 'POST', APPT, {
      patientRef,
      locationRef: loc.locationRef,
      startsAt: at(hour),
      endsAt: at(hour + 1),
      timeZone: 'America/New_York',
      provider: { kind: 'provider', resourceRef: loc.provider },
      operatory: { kind: 'operatory', resourceRef: loc.operatory },
    }),
    201,
  );
  return { appointmentRef: res.data.appointmentRef, patientRef };
}

type Author = { actorRef: string; role: string; credentialRef: string | null };
type Assignment = {
  sequence: number;
  role: string;
  assignee: { kind: string; resourceRef: string } | null;
  assignedBy: Author;
};
type Encounter = {
  encounterRef: string;
  patientRef: string;
  locationRef: string;
  appointment: {
    appointmentRef: string;
    statusAtOpen: string;
    currentStatus: string;
    rescheduledToRef: string | null;
  } | null;
  flags: string[];
  state: string;
  assignments: Assignment[];
  assignmentHistory: Assignment[];
  openedBy: Author;
  closure: { dispositionCode: string; closedBy: Author; closedAt: string } | null;
  version: number;
};
type OpenResult = { data: { outcome: string; encounter: Encounter }; version: number; replayed: boolean };

const treating = (resourceRef: string) => ({
  role: 'treating_provider',
  assignee: { kind: 'provider', resourceRef },
});

async function open(body: Record<string, unknown>, who = 'a1', key = randomUUID()) {
  return h.call(who, 'POST', ENC, body, key);
}

async function openFor(patient?: string): Promise<Encounter> {
  const a = await appointment(patient);
  return h.ok<OpenResult>(await open({ patientRef: a.patientRef, appointmentRef: a.appointmentRef }), 201)
    .data.encounter;
}

const auditCount = async (operation: string, ref: string) =>
  (
    await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.audit_events WHERE operation = $1 AND resource_ref = $2',
      [operation, ref],
    )
  ).rows[0].n as number;

describe('C5 acceptance cases', () => {
  it('1. opening twice for one appointment yields one encounter and one audit success', async () => {
    const a = await appointment();
    const body = {
      patientRef: a.patientRef,
      appointmentRef: a.appointmentRef,
      assignments: [treating(loc.provider)],
    };
    const key = randomUUID();
    const first = h.ok<OpenResult>(await open(body, 'a1', key), 201);
    expect(validateEncounterOpenResult(first)).toBe(true);
    expect(first.data.outcome).toBe('opened');
    const e = first.data.encounter;
    expect(e.patientRef).toBe(a.patientRef);
    expect(e.appointment).toStrictEqual({
      appointmentRef: a.appointmentRef,
      statusAtOpen: 'booked',
      currentStatus: 'booked',
      rescheduledToRef: null,
    });
    expect(e.openedBy).toMatchObject({ role: 'dentist', credentialRef: 'SYN-CRED-A1' });
    // The same key replays; a different key returns the existing encounter without applying anything.
    const replay = h.ok<OpenResult>(await open(body, 'a1', key), 201);
    expect([replay.replayed, replay.data.encounter.encounterRef]).toStrictEqual([true, e.encounterRef]);
    const second = h.ok<OpenResult>(
      await open({
        patientRef: a.patientRef,
        appointmentRef: a.appointmentRef,
        assignments: [treating(provider2)],
      }),
      201,
    );
    expect(second.data.outcome).toBe('existing');
    expect(second.data.encounter.encounterRef).toBe(e.encounterRef);
    expect(second.data.encounter.assignments.map((x) => x.assignee?.resourceRef)).toStrictEqual([
      loc.provider,
    ]);
    const { rows } = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.clinical_encounters WHERE appointment_id = $1',
      [a.appointmentRef],
    );
    expect(rows[0].n).toBe(1);
    expect(await auditCount('clinical.encounters.open', e.encounterRef)).toBe(1);
  });

  it('2. treating, secondary, supervising, staff and completing assignments are independent', async () => {
    const e = await openFor();
    let v = e.version;
    const assign = async (role: string, assignee: unknown) => {
      const r = h.ok<{ data: Encounter }>(
        await h.call('a1', 'POST', `${ENC}/${e.encounterRef}/assignments`, {
          expectedVersion: v,
          role,
          assignee,
        }),
        201,
      );
      v = r.data.version;
      return r.data;
    };
    await assign('treating_provider', { kind: 'provider', resourceRef: loc.provider });
    await assign('secondary_provider', { kind: 'provider', resourceRef: provider2 });
    await assign('supervising_provider', { kind: 'provider', resourceRef: loc.provider });
    await assign('staff', { kind: 'staff', resourceRef: staff });
    await assign('completing_provider', { kind: 'provider', resourceRef: provider2 });
    const before = (await assign('treating_provider', { kind: 'provider', resourceRef: provider2 }))
      .assignments;
    const byRole = Object.fromEntries(before.map((a) => [a.role, a.assignee?.resourceRef]));
    expect(byRole).toStrictEqual({
      treating_provider: provider2,
      secondary_provider: provider2,
      supervising_provider: loc.provider,
      staff,
      completing_provider: provider2,
    });
    // Unassigning one role leaves every other role unchanged; history keeps every assignment.
    const after = await assign('secondary_provider', null);
    expect(after.assignments.map((a) => a.role).sort()).toStrictEqual(
      ['completing_provider', 'staff', 'supervising_provider', 'treating_provider'].sort(),
    );
    expect(after.assignmentHistory).toHaveLength(7);
    expect(after.assignmentHistory.every((a) => a.assignedBy.role === 'dentist')).toBe(true);
    // Role/kind mismatch and unchanged assignments are refused.
    const bad = await h.call('a1', 'POST', `${ENC}/${e.encounterRef}/assignments`, {
      expectedVersion: v,
      role: 'staff',
      assignee: { kind: 'provider', resourceRef: loc.provider },
    });
    expect([bad.statusCode, bad.json().detail.violations[0].rule]).toStrictEqual([
      422,
      'kindDoesNotMatchRole',
    ]);
    const stale = await h.call('a1', 'POST', `${ENC}/${e.encounterRef}/assignments`, {
      expectedVersion: 1,
      role: 'staff',
      assignee: null,
    });
    expect([stale.statusCode, stale.json().code]).toStrictEqual([409, 'stale_version']);
  });

  it('3. closing without a configured disposition is refused; with one it is closed and audited', async () => {
    // An encounter without an appointment at loc-north, where the restricted hygienist a3 works.
    const e = h.ok<OpenResult>(
      await open({ patientRef: await createPatient(h, 'Synthetic North'), locationRef: 'loc-north' }),
      201,
    ).data.encounter;
    expect([e.appointment, e.locationRef]).toStrictEqual([null, 'loc-north']);
    const refused = await h.call('a1', 'POST', `${ENC}/${e.encounterRef}/close`, {
      expectedVersion: e.version,
      dispositionCode: 'not_a_configured_code',
    });
    expect([refused.statusCode, refused.json().detail.violations[0]]).toStrictEqual([
      422,
      { pointer: '/dispositionCode', rule: 'notConfigured' },
    ]);
    const closed = h.ok<{ data: Encounter }>(
      await h.call('a3', 'POST', `${ENC}/${e.encounterRef}/close`, {
        expectedVersion: e.version,
        dispositionCode: 'completed_as_planned',
      }),
    );
    expect(closed.data.state).toBe('closed');
    expect(closed.data.closure?.dispositionCode).toBe('completed_as_planned');
    // The closing author (a hygienist) is recorded separately from the opening author (a dentist).
    expect([closed.data.openedBy.role, closed.data.closure?.closedBy.role]).toStrictEqual([
      'dentist',
      'hygienist',
    ]);
    expect(await auditCount('clinical.encounters.close', e.encounterRef)).toBe(1);
    const again = await h.call('a1', 'POST', `${ENC}/${e.encounterRef}/close`, {
      expectedVersion: closed.data.version,
      dispositionCode: 'patient_left',
    });
    expect([again.statusCode, again.json().detail.reason]).toStrictEqual([409, 'encounter_closed']);
  });

  it('4. a closed encounter refuses new entries; the database refuses reopening or rewriting it', async () => {
    const e = await openFor();
    const closed = h.ok<{ data: Encounter }>(
      await h.call('a1', 'POST', `${ENC}/${e.encounterRef}/close`, {
        expectedVersion: e.version,
        dispositionCode: 'completed_as_planned',
      }),
    );
    const entry = await h.call('a1', 'POST', `${ENC}/${e.encounterRef}/assignments`, {
      expectedVersion: closed.data.version,
      role: 'staff',
      assignee: { kind: 'staff', resourceRef: staff },
    });
    expect([entry.statusCode, entry.json().detail]).toStrictEqual([
      409,
      { reason: 'encounter_closed', blockingRefs: [{ kind: 'clinicalEncounter', ref: e.encounterRef }] },
    ]);
    // Even the runtime role with direct SQL cannot reopen, re-close or rewrite authorship.
    for (const sql of [
      `UPDATE cuspatlas.clinical_encounters SET state = 'open', closed_at = NULL, closed_by = NULL,
         closed_by_role = NULL, disposition_code = NULL, version = version + 1 WHERE id = '${e.encounterRef}'`,
      `UPDATE cuspatlas.clinical_encounters SET opened_by_role = 'assistant' WHERE id = '${e.encounterRef}'`,
      `UPDATE cuspatlas.clinical_encounter_assignments SET role = 'staff'`,
      `DELETE FROM cuspatlas.clinical_encounters WHERE id = '${e.encounterRef}'`,
    ]) {
      const client = await db.app.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
        await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }
  });

  it('5. another tenant’s patient or appointment is refused without disclosing the record', async () => {
    const a = await appointment();
    const missing = await open({ patientRef: randomUUID(), locationRef: loc.locationRef }, 'b1');
    const foreign = await open({ patientRef: a.patientRef, appointmentRef: a.appointmentRef }, 'b1');
    expect(foreign.statusCode).toBe(404);
    expect({ ...foreign.json(), correlationId: null }).toStrictEqual({
      ...missing.json(),
      correlationId: null,
    });
    const betaPatient = await createPatient(h, 'Synthetic Beta', 'b1');
    const crossAppt = await open({ patientRef: betaPatient, appointmentRef: a.appointmentRef }, 'b1');
    expect(crossAppt.statusCode).toBe(404);
    const { rows } = await db.admin.query(
      `SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1`,
      [foreign.headers['x-correlation-id']],
    );
    expect(rows.map((r) => r.reason_code)).toStrictEqual(['resource_hidden_or_missing']);
    const beta = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.clinical_encounters WHERE tenant_id = $1',
      [T_BETA],
    );
    expect(beta.rows[0].n).toBe(0);
    // Another tenant reading an alpha encounter is the same 404.
    const e = await openFor();
    const read = await h.call('b1', 'GET', `${ENC}/${e.encounterRef}`);
    expect(read.statusCode).toBe(404);
  });

  it('6. an encounter for a cancelled appointment is permitted and flagged with the appointment state', async () => {
    const a = await appointment();
    h.ok(
      await h.call('a1', 'POST', `${APPT}/${a.appointmentRef}/cancel`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
      }),
    );
    const r = h.ok<OpenResult>(
      await open({ patientRef: a.patientRef, appointmentRef: a.appointmentRef }),
      201,
    );
    expect(r.data.encounter.appointment?.statusAtOpen).toBe('cancelled');
    expect(r.data.encounter.flags).toStrictEqual(['appointment_cancelled_at_open']);
  });
});

describe('C5 failure and recovery cases', () => {
  it('1. a failed close rolls back the disposition, audit and outbox together', async () => {
    const e = await openFor();
    const before = [await count(db, 'audit_events'), await count(db, 'outbox_events')];
    await db.admin.query('REVOKE INSERT ON cuspatlas.outbox_events FROM cuspatlas_app');
    try {
      const res = await h.call('a1', 'POST', `${ENC}/${e.encounterRef}/close`, {
        expectedVersion: e.version,
        dispositionCode: 'completed_as_planned',
      });
      expect(res.statusCode).toBe(500);
    } finally {
      await db.admin.query('GRANT INSERT ON cuspatlas.outbox_events TO cuspatlas_app');
    }
    const { rows } = await db.admin.query(
      'SELECT state, disposition_code, version FROM cuspatlas.clinical_encounters WHERE id = $1',
      [e.encounterRef],
    );
    expect(rows[0]).toStrictEqual({ state: 'open', disposition_code: null, version: e.version });
    expect([await count(db, 'audit_events'), await count(db, 'outbox_events')]).toStrictEqual(before);
  });

  it('2. two concurrent opens for one appointment produce one encounter, both returning it', async () => {
    const a = await appointment();
    const body = { patientRef: a.patientRef, appointmentRef: a.appointmentRef };
    const [x, y] = await Promise.all([open(body), open(body)]);
    const rx = h.ok<OpenResult>(x, 201);
    const ry = h.ok<OpenResult>(y, 201);
    expect(rx.data.encounter.encounterRef).toBe(ry.data.encounter.encounterRef);
    expect([rx.data.outcome, ry.data.outcome].sort()).toStrictEqual(['existing', 'opened']);
    expect(await auditCount('clinical.encounters.open', rx.data.encounter.encounterRef)).toBe(1);
  });

  it('3. a rescheduled appointment keeps the original reference and reports the change', async () => {
    const a = await appointment();
    const e = h.ok<OpenResult>(
      await open({ patientRef: a.patientRef, appointmentRef: a.appointmentRef }),
      201,
    ).data.encounter;
    const moved = h.ok<{ data: { appointmentRef: string } }>(
      await h.call('a1', 'POST', `${APPT}/${a.appointmentRef}/reschedule`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
        startsAt: new Date(Date.UTC(2031, 0, 7, 15)).toISOString(),
        endsAt: new Date(Date.UTC(2031, 0, 7, 16)).toISOString(),
        timeZone: 'America/New_York',
        provider: { kind: 'provider', resourceRef: loc.provider },
        operatory: { kind: 'operatory', resourceRef: loc.operatory },
      }),
    );
    const read = h.ok<{ data: Encounter }>(await h.call('a1', 'GET', `${ENC}/${e.encounterRef}`));
    expect(read.data.appointment).toStrictEqual({
      appointmentRef: a.appointmentRef,
      statusAtOpen: 'booked',
      currentStatus: 'rescheduled',
      rescheduledToRef: moved.data.appointmentRef,
    });
    expect(read.data.flags).toStrictEqual(['appointment_changed_since_open']);
    expect(read.data.version).toBe(e.version);
  });

  it('4. a merge relinks the encounter with an audit record and leaves clinical content untouched', async () => {
    const survivor = await createPatient(h, 'Synthetic Merge Clinical');
    const merged = await createPatient(h, 'Synthetic Merge Clinical');
    const e = await openFor(merged);
    const closed = h.ok<{ data: Encounter }>(
      await h.call('a1', 'POST', `${ENC}/${e.encounterRef}/close`, {
        expectedVersion: e.version,
        dispositionCode: 'completed_as_planned',
      }),
    ).data;
    const content = async () =>
      (
        await db.admin.query(
          `SELECT to_jsonb(e) - 'subject_patient_id' - 'version' - 'updated_at' AS row,
             (SELECT json_agg(a ORDER BY a.sequence) FROM cuspatlas.clinical_encounter_assignments a
               WHERE a.encounter_id = e.id) AS assignments
           FROM cuspatlas.clinical_encounters e WHERE e.id = $1`,
          [e.encounterRef],
        )
      ).rows[0];
    const before = await content();
    const mergeRef = await mergePatients(h, survivor, merged);
    expect(await content()).toStrictEqual(before);
    const read = h.ok<{ data: Encounter }>(await h.call('a1', 'GET', `${ENC}/${e.encounterRef}`)).data;
    expect(read.patientRef).toBe(survivor);
    expect(read.closure).toStrictEqual(closed.closure);
    expect(read.openedBy).toStrictEqual(closed.openedBy);
    const moves = await db.admin.query(
      `SELECT record_class, content_digest_before = content_digest_after AS same FROM cuspatlas.patient_merge_moves
       WHERE merge_id = $1 AND record_ref = $2`,
      [mergeRef, e.encounterRef],
    );
    expect(moves.rows).toStrictEqual([{ record_class: 'clinicalEncounter', same: true }]);
    const audit = await db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.audit_events WHERE operation = 'patients.merge'
         AND resource_type = 'clinicalEncounter' AND resource_ref = $1`,
      [e.encounterRef],
    );
    expect(audit.rows[0].n).toBe(1);
    // A new encounter for the merged-away identity is refused and names the survivor.
    const refused = await open({ patientRef: merged, locationRef: loc.locationRef });
    expect([refused.statusCode, refused.json().detail]).toStrictEqual([
      409,
      { reason: 'patient_merged', blockingRefs: [{ kind: 'patient', ref: survivor }] },
    ]);
    // S-D2 seam: a clinical fact on the survivor after the merge makes unmerge need the review.
    h.ok(await open({ patientRef: survivor, locationRef: loc.locationRef }), 201);
    const unmerge = await h.call('a1', 'POST', `/v1/patients/merges/${mergeRef}/unmerge`, {
      reasonCode: 'merged_in_error',
    });
    expect([unmerge.statusCode, unmerge.json().detail]).toStrictEqual([
      422,
      { reason: 'reconciliation_review_required' },
    ]);
    const reviewed = await h.call('a1', 'POST', `/v1/patients/merges/${mergeRef}/unmerge`, {
      reasonCode: 'reconciliation_review',
      reconciliationReviewRef: 'synthetic-review-c5',
    });
    expect(reviewed.statusCode).toBe(200);
    const back = h.ok<{ data: Encounter }>(await h.call('a1', 'GET', `${ENC}/${e.encounterRef}`)).data;
    expect([back.patientRef, back.closure]).toStrictEqual([merged, closed.closure]);
  });
});

describe('C5 structural merge assertion: a merge never rewrites clinical content', () => {
  it('every clinical merge class excludes only its reference, bookkeeping and write-once lifecycle columns', async () => {
    const clinical = MERGE_RECORD_CLASSES.filter((c) => c.factKind === 'clinical');
    expect(clinical.map((c) => c.table)).toContain('clinical_encounters');
    for (const cls of clinical) {
      // The runtime role may update exactly the excluded columns (the reference, lifecycle and
      // bookkeeping), so every column the digest covers is unwritable by any application path.
      const { rows } = await db.admin.query(
        `SELECT column_name FROM information_schema.column_privileges WHERE table_schema = 'cuspatlas'
           AND table_name = $1 AND grantee = 'cuspatlas_app' AND privilege_type = 'UPDATE' ORDER BY 1`,
        [cls.table],
      );
      expect([cls.table, rows.map((r) => r.column_name)]).toStrictEqual([
        cls.table,
        [...cls.digestExclude].sort(),
      ]);
    }
  });
});

describe('C5 authorship', () => {
  it('a member without a clinical author profile is refused and the attempt is recorded', async () => {
    const a = await appointment();
    const res = await h.call(a7, 'POST', ENC, { patientRef: a.patientRef, appointmentRef: a.appointmentRef });
    expect([res.statusCode, res.json().code, res.json().detail]).toStrictEqual([
      403,
      'forbidden',
      { reason: 'clinical_author_missing' },
    ]);
    const { rows } = await db.admin.query(
      'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
      [res.headers['x-correlation-id']],
    );
    expect(rows.map((r) => r.reason_code)).toStrictEqual(['clinical_author_unresolved']);
    const ctx = h.ok<{ data: { resolvable: boolean; reason: string | null } }>(
      await h.call(a7, 'GET', '/v1/clinical/author-context'),
    );
    expect(ctx.data).toStrictEqual({ resolvable: false, author: null, reason: 'no_profile' });
  });

  it('a service principal is never a clinical author, even with clinical.write', async () => {
    const a = await appointment();
    const res = await h.call('svcA1', 'POST', ENC, {
      patientRef: a.patientRef,
      appointmentRef: a.appointmentRef,
    });
    expect([res.statusCode, res.json().code]).toStrictEqual([403, 'forbidden']);
    const ctx = h.ok<{ data: unknown }>(await h.call('svcA1', 'GET', '/v1/clinical/author-context'));
    expect(ctx.data).toStrictEqual({ resolvable: false, author: null, reason: 'service_principal' });
  });

  it('an admin defines and deactivates a profile; the author context follows it', async () => {
    const def = h.ok<{ data: { version: number; role: string } }>(
      await h.call('a1', 'POST', '/v1/clinical/authors', { actorRef: USER_A7, role: 'assistant' }),
      201,
    );
    expect(def.data).toStrictEqual({
      actorRef: USER_A7,
      role: 'assistant',
      credentialRef: null,
      active: true,
      version: 1,
    });
    const dup = await h.call('a1', 'POST', '/v1/clinical/authors', { actorRef: USER_A7, role: 'dentist' });
    expect([dup.statusCode, dup.json().detail.reason]).toStrictEqual([409, 'author_profile_exists']);
    const ctx = h.ok<{ data: { author: { role: string } } }>(
      await h.call(a7, 'GET', '/v1/clinical/author-context'),
    );
    expect(ctx.data.author.role).toBe('assistant');
    // Now a7 may open an encounter; its authorship records the assistant role.
    const a = await appointment();
    const e = h.ok<OpenResult>(
      await open({ patientRef: a.patientRef, appointmentRef: a.appointmentRef }, a7),
      201,
    );
    expect(e.data.encounter.openedBy).toStrictEqual({
      actorRef: USER_A7,
      role: 'assistant',
      credentialRef: null,
    });
    h.ok(
      await h.call('a1', 'POST', '/v1/clinical/authors', {
        actorRef: USER_A7,
        role: 'assistant',
        active: false,
        expectedVersion: 1,
      }),
      201,
    );
    const refused = await h.call(a7, 'POST', `${ENC}/${e.data.encounter.encounterRef}/close`, {
      expectedVersion: 1,
      dispositionCode: 'completed_as_planned',
    });
    expect([refused.statusCode, refused.json().detail.reason]).toStrictEqual([
      403,
      'clinical_author_inactive',
    ]);
    // A non-member actor is the same 404 as a missing record.
    const ghost = await h.call('a1', 'POST', '/v1/clinical/authors', {
      actorRef: randomUUID(),
      role: 'dentist',
    });
    expect(ghost.statusCode).toBe(404);
  });
});

describe('C5 separation, visibility, privacy and parity', () => {
  it('attendance is not clinical completion: neither command changes the other fact', async () => {
    const a = await appointment();
    h.ok(await h.call('a1', 'POST', `${APPT}/${a.appointmentRef}/attendance`, { kind: 'arrived' }), 201);
    expect(
      (
        await db.admin.query(
          'SELECT count(*)::int AS n FROM cuspatlas.clinical_encounters WHERE appointment_id = $1',
          [a.appointmentRef],
        )
      ).rows[0].n,
    ).toBe(0);
    const e = h.ok<OpenResult>(
      await open({ patientRef: a.patientRef, appointmentRef: a.appointmentRef }),
      201,
    ).data.encounter;
    h.ok(
      await h.call('a1', 'POST', `${ENC}/${e.encounterRef}/close`, {
        expectedVersion: e.version,
        dispositionCode: 'completed_as_planned',
      }),
    );
    const visit = h.ok<{ data: { attendance: { state: string }; booking: { status: string } } }>(
      await h.call('a1', 'GET', `${APPT}/${a.appointmentRef}/visit-status`),
    );
    expect([visit.data.attendance.state, visit.data.booking.status]).toStrictEqual(['arrived', 'booked']);
  });

  it('a location-restricted member cannot see another location’s encounter; lists filter it out', async () => {
    const e = await openFor();
    const read = await h.call('a3', 'GET', `${ENC}/${e.encounterRef}`);
    expect(read.statusCode).toBe(404);
    const list = h.ok<{ data: Encounter[] }>(
      await h.call('a3', 'GET', `/v1/clinical/patients/${e.patientRef}/encounters`),
    );
    expect(list.data).toStrictEqual([]);
    const own = h.ok(await h.call('a1', 'GET', `/v1/clinical/patients/${e.patientRef}/encounters`));
    expect(validateEncounterList(own)).toBe(true);
    expect((own as { data: Encounter[] }).data.map((x) => x.encounterRef)).toStrictEqual([e.encounterRef]);
    const none = h.ok(
      await h.call(
        'a1',
        'GET',
        `/v1/clinical/patients/${await createPatient(h, 'Synthetic Empty')}/encounters`,
      ),
    );
    expect(none).toStrictEqual({ data: [], nextCursor: null });
  });

  it('reads are sensitive-read logged with references only', async () => {
    const e = await openFor();
    const res = await h.call('a4', 'GET', `${ENC}/${e.encounterRef}`);
    expect(validateEncounterRead(res.json())).toBe(true);
    const { rows } = await db.admin.query(
      `SELECT operation, resource_type, resource_refs::text[] AS refs, query_fields FROM cuspatlas.sensitive_read_events
       WHERE correlation_id = $1`,
      [res.headers['x-correlation-id']],
    );
    expect(rows).toStrictEqual([
      {
        operation: 'clinical.encounters.read',
        resource_type: 'clinicalEncounter',
        refs: [e.encounterRef],
        query_fields: [],
      },
    ]);
    // A read-only member cannot write.
    const w = await h.call('a4', 'POST', `${ENC}/${e.encounterRef}/close`, {
      expectedVersion: e.version,
      dispositionCode: 'completed_as_planned',
    });
    expect([w.statusCode, w.json().code]).toStrictEqual([403, 'forbidden']);
  });

  it('the marker in credentials and patient names never reaches logs or audit, outbox, attempt, idempotency or sensitive-read rows', async () => {
    h.ok(
      await h.call('a1', 'POST', '/v1/clinical/authors', {
        actorRef: USER_A7,
        role: 'assistant',
        credentialRef: MARKER,
        active: true,
        expectedVersion: 2,
      }),
      201,
    );
    const a = await appointment(await createPatient(h, `Synthetic ${MARKER}`));
    const e = h.ok<OpenResult>(
      await open({ patientRef: a.patientRef, appointmentRef: a.appointmentRef }, a7),
      201,
    );
    expect(e.data.encounter.openedBy.credentialRef).toBe(MARKER);
    await h.call(a7, 'GET', `${ENC}/${e.data.encounter.encounterRef}`);
    const refused = await h.call('b1', 'POST', ENC, {
      patientRef: a.patientRef,
      locationRef: MARKER.toLowerCase(),
    });
    expect(refused.body).not.toContain(MARKER);
    const surface = await leakTables(db);
    const reads = (
      await db.admin.query(
        `SELECT coalesce(json_agg(t)::text, '') AS j FROM cuspatlas.sensitive_read_events t`,
      )
    ).rows[0].j as string;
    expect(`${surface}${reads}${h.logLines.join('\n')}`).not.toContain(MARKER);
  });

  it('MCP opens replay REST with the same key, and refusals are identical on both surfaces', async () => {
    const a = await appointment();
    const key = randomUUID();
    const body = { patientRef: a.patientRef, appointmentRef: a.appointmentRef };
    const rest = h.ok<OpenResult>(await open(body, 'a1', key), 201);
    const viaMcp = await h.mcp('a1', 'clinical_encounters_open', { ...body, idempotencyKey: key }, 201);
    expect(viaMcp.code).toBeNull();
    expect((viaMcp.body as OpenResult).replayed).toBe(true);
    expect((viaMcp.body as OpenResult).data.encounter.encounterRef).toBe(rest.data.encounter.encounterRef);
    const restClose = await h.call('a1', 'POST', `${ENC}/${rest.data.encounter.encounterRef}/close`, {
      expectedVersion: rest.data.encounter.version,
      dispositionCode: 'nope',
    });
    const mcpClose = await h.mcp('a1', 'clinical_encounters_close', {
      encounterRef: rest.data.encounter.encounterRef,
      expectedVersion: rest.data.encounter.version,
      dispositionCode: 'nope',
      idempotencyKey: randomUUID(),
    });
    expect([mcpClose.status, mcpClose.body.detail]).toStrictEqual([
      restClose.statusCode,
      restClose.json().detail,
    ]);
    const read = await h.mcp('b1', 'clinical_encounters_get', {
      encounterRef: rest.data.encounter.encounterRef,
    });
    expect([read.status, read.code]).toStrictEqual([404, 'not_found']);
  });
});
