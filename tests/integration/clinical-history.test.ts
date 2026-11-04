import { randomUUID } from 'node:crypto';
import { validateActiveAlerts, validateHistoryRead, validateHistoryVersionRead } from '@cuspatlas/contracts';
import { createTenantTransactionRunner } from '@cuspatlas/db';
import { resolveHistoryReference } from '@cuspatlas/domain';
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
  USER_A1,
} from './support/appointment-fixtures';
import { seedClinicalScopes, seedDispositions, USER_A7 } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor } from './support/fixtures';
import { MARKER } from './support/marker';

/**
 * C8: medical history, allergies and medications as append-only versions (synthetic engineering
 * implementation; semantics recommended-pending-clinical-approval; no drug database, no interaction
 * checking, no decision support). Every denial runs under the runtime role.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let a7: string;
const CHANGES = '/v1/clinical/history/changes';
const LOC = 'loc-history';

beforeAll(async () => {
  db = await openTestDatabase('clinical_history');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedClinicalScopes(db.admin);
  await seedDispositions(db.admin, T_ALPHA, ['completed_as_planned']);
  await seedLocation(h, LOC);
  a7 = await h.issuer.issue({ sub: USER_A7, tid: T_ALPHA });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

type Header = { historyVersionRef: string; version: number; provenance: string; recordedAt: string };
type Change = {
  changeRef: string;
  itemSequence: number;
  state: string;
  displayText: string | null;
  detailText: string | null;
  effectiveUntil: string | null;
  reasonCode: string | null;
  recorded: Header;
};
type Item = {
  itemRef: string;
  kind: string;
  entryType: string;
  streamRef: string;
  sourcePatientRef: string;
  current: Change;
  verification: { changeRef: string; verifiedBy: { actorRef: string; role: string } } | null;
  changes: Change[];
  verifications: { changeRef: string }[];
};
type Version = { header: Header; changes: { itemRef: string; kind: string; change: Change }[] };
type Read = {
  recorded: boolean;
  asOf: string;
  streams: { streamRef: string; sourcePatientRef: string; version: number }[];
  items: Item[];
};
type Section = {
  status: string;
  items: { itemRef: string; verified: boolean; provenance: string }[];
  noneKnown: { itemRef: string } | null;
  lastReview: { stale: boolean; outcome: string } | null;
};
type Alerts = {
  allergy: Section;
  condition: Section;
  medication: Section;
  interactionChecking: { provided: boolean };
  decisionSupport: { provided: boolean };
};

const staff = { provenance: 'staff', reportedBy: 'clinician' };
const reported = { provenance: 'patient_reported', reportedBy: 'patient' };

const rec = (body: Record<string, unknown>, who = 'a1', key = randomUUID()) =>
  h.call(who, 'POST', CHANGES, body, key);
async function record(patientRef: string, changes: unknown[], extra: Record<string, unknown> = staff) {
  return h.ok<{ data: Version; version: number; replayed: boolean }>(
    await rec({ patientRef, ...extra, changes }),
    201,
  );
}
const read = async (patientRef: string, asOf?: string, who = 'a1') =>
  h.ok<{ data: Read }>(
    await h.call(
      who,
      'GET',
      `/v1/clinical/patients/${patientRef}/history${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`,
    ),
  ).data;
const alerts = async (patientRef: string) =>
  h.ok<{ data: Alerts }>(await h.call('a1', 'GET', `/v1/clinical/patients/${patientRef}/alerts`)).data;
async function encounter(patientRef: string): Promise<{ encounterRef: string; version: number }> {
  const r = h.ok<{ data: { encounter: { encounterRef: string; version: number } } }>(
    await h.call('a1', 'POST', '/v1/clinical/encounters', { patientRef, locationRef: LOC }),
    201,
  );
  return r.data.encounter;
}
const pause = () => new Promise((r) => setTimeout(r, 5));

describe('C8 acceptance cases', () => {
  it('1. an allergy added and later marked entered_in_error reads correctly at both instants', async () => {
    const p = await createPatient(h, 'Synthetic History One');
    const v1 = await record(p, [
      { kind: 'allergy', state: 'active', displayText: 'Synthetic allergen A', codeRef: 'SYN-ALG-001' },
    ]);
    expect(v1.version).toBe(1);
    const itemRef = v1.data.changes[0]?.itemRef as string;
    const t1 = v1.data.header.recordedAt;
    await pause();
    const v2 = await record(p, [
      { itemRef, state: 'entered_in_error', reasonCode: 'recorded_for_wrong_patient' },
    ]);
    expect(v2.version).toBe(2);
    const then = await read(p, t1);
    expect(then.items.map((i) => [i.current.state, i.current.displayText])).toStrictEqual([
      ['active', 'Synthetic allergen A'],
    ]);
    const now = await read(p);
    expect(now.items[0]?.current).toMatchObject({
      state: 'entered_in_error',
      reasonCode: 'recorded_for_wrong_patient',
      displayText: 'Synthetic allergen A',
    });
    expect(now.items[0]?.changes.map((c) => c.state)).toStrictEqual(['active', 'entered_in_error']);
    const first = h.ok(
      await h.call('a1', 'GET', `/v1/clinical/history/versions/${v1.data.header.historyVersionRef}`),
    );
    expect(validateHistoryVersionRead(first)).toBe(true);
    expect((first as { data: Version }).data.changes[0]?.change.state).toBe('active');
    // Nothing is deleted: both changes remain, and an entered_in_error item takes no further change.
    const again = await rec({ patientRef: p, ...staff, changes: [{ itemRef, state: 'active' }] });
    expect([again.statusCode, again.json().detail.reason]).toStrictEqual([409, 'item_entered_in_error']);
  });

  it('2. patient-reported and clinician-verified allergies are distinguishable; verification names who and when', async () => {
    const p = await createPatient(h, 'Synthetic History Two');
    const v = await record(
      p,
      [
        {
          kind: 'allergy',
          state: 'active',
          displayText: 'Synthetic allergen B',
          detailText: 'Synthetic rash',
        },
        { kind: 'allergy', state: 'active', displayText: 'Synthetic allergen C' },
      ],
      reported,
    );
    const [b, c] = v.data.changes;
    const verified = h.ok<{ data: Item }>(
      await h.call('a3', 'POST', `/v1/clinical/history/items/${b?.itemRef}/verifications`, {
        expectedChangeRef: b?.change.changeRef,
      }),
      201,
    ).data;
    expect(verified.verification?.verifiedBy).toMatchObject({ role: 'hygienist' });
    // The reported value and its provenance are untouched by verification.
    expect(verified.current).toMatchObject({
      displayText: 'Synthetic allergen B',
      detailText: 'Synthetic rash',
    });
    expect(verified.current.recorded.provenance).toBe('patient_reported');
    const a = await alerts(p);
    expect(validateActiveAlerts({ data: a })).toBe(true);
    expect(
      Object.fromEntries(a.allergy.items.map((i) => [i.itemRef, [i.provenance, i.verified]])),
    ).toStrictEqual({
      [b?.itemRef as string]: ['patient_reported', true],
      [c?.itemRef as string]: ['patient_reported', false],
    });
    const twice = await h.call('a1', 'POST', `/v1/clinical/history/items/${b?.itemRef}/verifications`, {
      expectedChangeRef: b?.change.changeRef,
    });
    expect([twice.statusCode, twice.json().detail.reason]).toStrictEqual([409, 'already_verified']);
  });

  it('3. an as-of read returns that version, and later changes do not alter it', async () => {
    const p = await createPatient(h, 'Synthetic History Three');
    const v1 = await record(p, [
      { kind: 'condition', state: 'active', displayText: 'Synthetic condition X' },
    ]);
    const t1 = v1.data.header.recordedAt;
    const snapshot = await read(p, t1);
    await pause();
    const itemRef = v1.data.changes[0]?.itemRef as string;
    await record(p, [{ itemRef, state: 'resolved', reasonCode: 'resolved_per_report' }]);
    await record(p, [{ kind: 'medication', state: 'active', displayText: 'Synthetic medication M' }]);
    const later = await read(p, t1);
    expect(later).toStrictEqual(snapshot);
    expect(later.items.map((i) => i.current.state)).toStrictEqual(['active']);
    expect(later.streams.map((s) => s.version)).toStrictEqual([1]);
    expect((await read(p)).streams.map((s) => s.version)).toStrictEqual([3]);
    const future = await h.call(
      'a1',
      'GET',
      `/v1/clinical/patients/${p}/history?asOf=${encodeURIComponent('2099-01-01T00:00:00Z')}`,
    );
    expect([future.statusCode, future.json().detail.violations[0].rule]).toStrictEqual([422, 'inTheFuture']);
  });

  it('4. no recorded allergy data is unknown, never "no allergies"; none-reported and reviewed-none are distinct', async () => {
    const p = await createPatient(h, 'Synthetic History Four');
    const empty = await read(p);
    expect(validateHistoryRead({ data: empty })).toBe(true);
    expect([empty.recorded, empty.items]).toStrictEqual([false, []]);
    const unknown = await alerts(p);
    expect([unknown.allergy.status, unknown.condition.status, unknown.medication.status]).toStrictEqual([
      'unknown',
      'unknown',
      'unknown',
    ]);
    expect([unknown.interactionChecking.provided, unknown.decisionSupport.provided]).toStrictEqual([
      false,
      false,
    ]);
    // The patient reports no known allergies: none_reported, not reviewed and not "none".
    const none = await record(p, [{ kind: 'allergy', entryType: 'none_known', state: 'active' }], reported);
    const noneRef = none.data.changes[0]?.itemRef as string;
    expect((await alerts(p)).allergy.status).toBe('none_reported');
    // A clinician attests at an encounter that allergies were reviewed and none are present.
    const e = await encounter(p);
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/encounters/${e.encounterRef}/history-reviews`, {
        allergy: 'none',
      }),
      201,
    );
    const reviewed = await alerts(p);
    expect([reviewed.allergy.status, reviewed.allergy.lastReview?.stale]).toStrictEqual([
      'reviewed_none',
      false,
    ]);
    expect(reviewed.medication.status).toBe('unknown');
    // A new allergy while "none known" is active must resolve that statement explicitly.
    const clash = await rec({
      patientRef: p,
      ...staff,
      changes: [{ kind: 'allergy', state: 'active', displayText: 'Synthetic allergen D' }],
    });
    expect([clash.statusCode, clash.json().detail]).toStrictEqual([
      409,
      { reason: 'none_known_active', blockingRefs: [{ kind: 'historyItem', ref: noneRef }] },
    ]);
    await pause();
    await record(p, [
      { itemRef: noneRef, state: 'resolved', reasonCode: 'superseded_by_report' },
      { kind: 'allergy', state: 'active', displayText: 'Synthetic allergen D' },
    ]);
    const present = await alerts(p);
    expect([present.allergy.status, present.allergy.lastReview?.stale]).toStrictEqual(['present', true]);
    const attest = await h.call('a1', 'POST', `/v1/clinical/encounters/${e.encounterRef}/history-reviews`, {
      allergy: 'none',
    });
    expect([attest.statusCode, attest.json().detail.reason]).toStrictEqual([409, 'active_items_present']);
  });

  it('5. another tenant cannot record, read, read a version of or alert on an alpha patient', async () => {
    const p = await createPatient(h, 'Synthetic History Five');
    const v = await record(p, [{ kind: 'allergy', state: 'active', displayText: 'Synthetic allergen E' }]);
    const before = await count(db, 'clinical_history_versions');
    const missing = await rec(
      {
        patientRef: randomUUID(),
        ...staff,
        changes: [{ kind: 'social', state: 'active', displayText: 'x' }],
      },
      'b1',
    );
    const foreign = await rec(
      { patientRef: p, ...staff, changes: [{ kind: 'social', state: 'active', displayText: 'x' }] },
      'b1',
    );
    expect(foreign.statusCode).toBe(404);
    expect({ ...foreign.json(), correlationId: null }).toStrictEqual({
      ...missing.json(),
      correlationId: null,
    });
    for (const url of [
      `/v1/clinical/patients/${p}/history`,
      `/v1/clinical/patients/${p}/alerts`,
      `/v1/clinical/history/versions/${v.data.header.historyVersionRef}`,
    ]) {
      expect([url, (await h.call('b1', 'GET', url)).statusCode]).toStrictEqual([url, 404]);
    }
    const verify = await h.call(
      'b1',
      'POST',
      `/v1/clinical/history/items/${v.data.changes[0]?.itemRef}/verifications`,
      {
        expectedChangeRef: v.data.changes[0]?.change.changeRef,
      },
    );
    expect(verify.statusCode).toBe(404);
    expect(await count(db, 'clinical_history_versions')).toBe(before);
  });

  it('6. a medication discontinued without an end date stores an explicit discontinued state', async () => {
    const p = await createPatient(h, 'Synthetic History Six');
    const v = await record(p, [
      {
        kind: 'medication',
        state: 'active',
        displayText: 'Synthetic medication N',
        effectiveFrom: '2025-01-01',
      },
    ]);
    const itemRef = v.data.changes[0]?.itemRef as string;
    await record(p, [{ itemRef, state: 'discontinued', reasonCode: 'patient_stopped' }]);
    const item = (await read(p)).items[0];
    expect(item?.current).toMatchObject({
      state: 'discontinued',
      effectiveUntil: null,
      reasonCode: 'patient_stopped',
    });
    expect((await alerts(p)).medication.status).toBe('unknown');
    // discontinued is a medication state only; a non-active state needs a reason.
    const wrongKind = await rec({
      patientRef: p,
      ...staff,
      changes: [{ kind: 'allergy', state: 'discontinued', displayText: 'x', reasonCode: 'x' }],
    });
    expect(wrongKind.json().detail.violations[0].rule).toBe('stateNotForKind');
    const noReason = await rec({ patientRef: p, ...staff, changes: [{ itemRef, state: 'discontinued' }] });
    expect(noReason.json().detail.violations[0]).toStrictEqual({
      pointer: '/changes/0/reasonCode',
      rule: 'required',
    });
  });
});

describe('C8 failure and recovery cases', () => {
  it('1. a duplicate submission is idempotent; concurrent conflicting changes both persist in order', async () => {
    const p = await createPatient(h, 'Synthetic History Dup');
    const key = randomUUID();
    const body = {
      patientRef: p,
      ...staff,
      changes: [{ kind: 'vital', state: 'active', displayText: 'Synthetic BP' }],
    };
    const first = h.ok<{ data: Version; replayed: boolean }>(await rec(body, 'a1', key), 201);
    const again = h.ok<{ data: Version; replayed: boolean }>(await rec(body, 'a1', key), 201);
    expect([again.replayed, again.data.header.historyVersionRef]).toStrictEqual([
      true,
      first.data.header.historyVersionRef,
    ]);
    const itemRef = first.data.changes[0]?.itemRef as string;
    const [x, y] = await Promise.all([
      rec({
        patientRef: p,
        ...staff,
        changes: [{ itemRef, state: 'active', detailText: 'Synthetic reading one' }],
      }),
      rec({
        patientRef: p,
        ...staff,
        changes: [{ itemRef, state: 'active', detailText: 'Synthetic reading two' }],
      }),
    ]);
    const vx = h.ok<{ version: number }>(x, 201).version;
    const vy = h.ok<{ version: number }>(y, 201).version;
    expect([vx, vy].sort()).toStrictEqual([2, 3]);
    const item = (await read(p)).items[0];
    expect(item?.changes.map((c) => c.itemSequence)).toStrictEqual([1, 2, 3]);
    // With expectedVersion, a stale writer is refused instead.
    const stale = await rec({ ...body, expectedVersion: 1, changes: [{ itemRef, state: 'active' }] });
    expect([stale.statusCode, stale.json().code, stale.json().detail.currentVersion]).toStrictEqual([
      409,
      'stale_version',
      3,
    ]);
  });

  it('2. an imported batch carries imported provenance and its source, and is never attributed to a verification', async () => {
    const p = await createPatient(h, 'Synthetic History Import');
    const noSource = await rec({
      patientRef: p,
      provenance: 'imported',
      reportedBy: 'external_record',
      changes: [{ kind: 'condition', state: 'active', displayText: 'Synthetic imported condition' }],
    });
    expect(noSource.json().detail.violations[0]).toStrictEqual({ pointer: '/sourceRef', rule: 'required' });
    const smuggled = await rec({
      patientRef: p,
      provenance: 'imported',
      reportedBy: 'external_record',
      sourceRef: 'synthetic-import-1',
      verifiedBy: USER_A1,
      changes: [{ kind: 'condition', state: 'active', displayText: 'Synthetic imported condition' }],
    });
    expect(smuggled.statusCode).toBe(400);
    const v = await record(
      p,
      [{ kind: 'condition', state: 'active', displayText: 'Synthetic imported condition' }],
      {
        provenance: 'imported',
        reportedBy: 'external_record',
        sourceRef: 'synthetic-import-1',
      },
    );
    expect(v.data.header).toMatchObject({
      provenance: 'imported',
      reportedBy: 'external_record',
      sourceRef: 'synthetic-import-1',
    });
    expect((await read(p)).items[0]?.verification).toBeNull();
    const mixed = await rec({
      patientRef: p,
      provenance: 'staff',
      reportedBy: 'external_record',
      changes: [{ kind: 'social', state: 'active', displayText: 'x' }],
    });
    expect(mixed.json().detail.violations[0].rule).toBe('externalRecordNeedsImported');
  });

  it('3. a change against a closed encounter is refused and the alternative path is named', async () => {
    const p = await createPatient(h, 'Synthetic History Closed');
    const e = await encounter(p);
    await record(p, [{ kind: 'social', state: 'active', displayText: 'Synthetic social note' }], {
      ...staff,
      encounterRef: e.encounterRef,
    });
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/encounters/${e.encounterRef}/close`, {
        expectedVersion: e.version,
        dispositionCode: 'completed_as_planned',
      }),
    );
    const res = await rec({
      patientRef: p,
      ...staff,
      encounterRef: e.encounterRef,
      changes: [{ kind: 'social', state: 'active', displayText: 'Synthetic late note' }],
    });
    expect([res.statusCode, res.json().detail]).toStrictEqual([
      409,
      {
        reason: 'encounter_closed',
        blockingRefs: [{ kind: 'clinicalEncounter', ref: e.encounterRef }],
        alternative: 'clinical.encounters.open',
      },
    ]);
    // The same change outside any encounter is accepted.
    await record(p, [{ kind: 'social', state: 'active', displayText: 'Synthetic late note' }]);
    // An encounter of another patient is refused.
    const other = await encounter(await createPatient(h, 'Synthetic Other'));
    const mismatch = await rec({
      patientRef: p,
      ...staff,
      encounterRef: other.encounterRef,
      changes: [{ kind: 'social', state: 'active', displayText: 'x' }],
    });
    expect(mismatch.json().detail.violations[0].rule).toBe('encounterPatientMismatch');
  });

  it('4. a verified item later corrected needs a new verification; the prior one is kept', async () => {
    const p = await createPatient(h, 'Synthetic History Verify');
    const v = await record(
      p,
      [{ kind: 'allergy', state: 'active', displayText: 'Synthetic allergen F' }],
      reported,
    );
    const itemRef = v.data.changes[0]?.itemRef as string;
    const firstChange = v.data.changes[0]?.change.changeRef as string;
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/history/items/${itemRef}/verifications`, {
        expectedChangeRef: firstChange,
      }),
      201,
    );
    const corrected = await record(p, [
      { itemRef, state: 'active', detailText: 'Synthetic reaction corrected' },
    ]);
    const item = (await read(p)).items[0];
    expect(item?.verification).toBeNull();
    expect(item?.verifications.map((x) => x.changeRef)).toStrictEqual([firstChange]);
    const stale = await h.call('a1', 'POST', `/v1/clinical/history/items/${itemRef}/verifications`, {
      expectedChangeRef: firstChange,
    });
    expect([stale.statusCode, stale.json().detail.reason]).toStrictEqual([409, 'item_changed']);
    const newChange = corrected.data.changes[0]?.change.changeRef as string;
    const again = h.ok<{ data: Item }>(
      await h.call('a1', 'POST', `/v1/clinical/history/items/${itemRef}/verifications`, {
        expectedChangeRef: newChange,
      }),
      201,
    ).data;
    expect(again.verification?.changeRef).toBe(newChange);
    expect(again.verifications.map((x) => x.changeRef)).toStrictEqual([firstChange, newChange]);
  });
});

describe('C8 append-only storage, merge, authorship, privacy, seam and parity', () => {
  it('the runtime role cannot update or delete any history row', async () => {
    const p = await createPatient(h, 'Synthetic History Append');
    await record(p, [{ kind: 'allergy', state: 'active', displayText: 'Synthetic allergen G' }]);
    for (const sql of [
      `UPDATE cuspatlas.clinical_history_changes SET display_text = 'rewritten'`,
      `UPDATE cuspatlas.clinical_history_versions SET provenance = 'staff'`,
      `UPDATE cuspatlas.clinical_history_items SET kind = 'vital'`,
      'DELETE FROM cuspatlas.clinical_history_changes',
      'DELETE FROM cuspatlas.clinical_history_streams',
      `UPDATE cuspatlas.clinical_history_streams SET origin_patient_id = subject_patient_id, version = version + 1`,
      `UPDATE cuspatlas.clinical_history_streams SET head_sequence = head_sequence + 5, version = version + 1`,
    ]) {
      const client = await db.app.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
        await expect([
          sql,
          await client.query(sql).then(
            () => 'ok',
            (e) => e.code,
          ),
        ]).toStrictEqual([sql, '42501']);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }
  });

  it('a merge keeps both histories distinct, rewrites no history row, and the merged identity is redirected', async () => {
    const survivor = await createPatient(h, 'Synthetic Merge History');
    const merged = await createPatient(h, 'Synthetic Merge History');
    await record(survivor, [{ kind: 'allergy', state: 'active', displayText: 'Synthetic allergen S' }]);
    await record(merged, [{ kind: 'medication', state: 'active', displayText: 'Synthetic medication T' }]);
    const rows = async () =>
      (
        await db.admin.query(
          `SELECT (SELECT json_agg(v ORDER BY v.id) FROM cuspatlas.clinical_history_versions v) AS v,
             (SELECT json_agg(c ORDER BY c.id) FROM cuspatlas.clinical_history_changes c) AS c,
             (SELECT json_agg(i ORDER BY i.id) FROM cuspatlas.clinical_history_items i) AS i`,
        )
      ).rows[0];
    const before = await rows();
    const mergeRef = await mergePatients(h, survivor, merged);
    expect(await rows()).toStrictEqual(before);
    const after = await read(survivor);
    expect(after.streams.map((s) => s.sourcePatientRef).sort()).toStrictEqual([merged, survivor].sort());
    expect(Object.fromEntries(after.items.map((i) => [i.kind, i.sourcePatientRef]))).toStrictEqual({
      allergy: survivor,
      medication: merged,
    });
    const moves = await db.admin.query(
      `SELECT record_class, content_digest_before = content_digest_after AS same FROM cuspatlas.patient_merge_moves
       WHERE merge_id = $1 AND record_class = 'clinicalHistoryStream'`,
      [mergeRef],
    );
    expect(moves.rows).toStrictEqual([{ record_class: 'clinicalHistoryStream', same: true }]);
    const redirected = await h.call('a1', 'GET', `/v1/clinical/patients/${merged}/alerts`);
    expect([redirected.statusCode, redirected.json().detail]).toStrictEqual([
      409,
      { reason: 'patient_merged', blockingRefs: [{ kind: 'patient', ref: survivor }] },
    ]);
  });

  it('writes need a clinical author; a read-only member reads but cannot write', async () => {
    const p = await createPatient(h, 'Synthetic History Authors');
    const front = await rec(
      { patientRef: p, ...staff, changes: [{ kind: 'social', state: 'active', displayText: 'x' }] },
      a7,
    );
    expect([front.statusCode, front.json().detail.reason]).toStrictEqual([403, 'clinical_author_missing']);
    const ro = await rec(
      { patientRef: p, ...staff, changes: [{ kind: 'social', state: 'active', displayText: 'x' }] },
      'a4',
    );
    expect([ro.statusCode, ro.json().code]).toStrictEqual([403, 'forbidden']);
    expect((await read(p, undefined, 'a4')).recorded).toBe(false);
    const svc = await rec(
      { patientRef: p, ...staff, changes: [{ kind: 'social', state: 'active', displayText: 'x' }] },
      'svcA1',
    );
    expect(svc.statusCode).toBe(403);
  });

  it('the marker in history text never reaches logs, audit, outbox, attempts, idempotency or sensitive-read rows', async () => {
    const p = await createPatient(h, 'Synthetic History Marker');
    const v = await record(p, [
      {
        kind: 'allergy',
        state: 'active',
        displayText: `Synthetic ${MARKER}`,
        detailText: `Reaction ${MARKER}`,
      },
    ]);
    expect(v.data.changes[0]?.change.displayText).toBe(`Synthetic ${MARKER}`);
    await read(p);
    await alerts(p);
    await rec(
      { patientRef: p, ...staff, changes: [{ kind: 'allergy', state: 'resolved', displayText: MARKER }] },
      'b1',
    );
    const reads = (
      await db.admin.query(
        `SELECT coalesce(json_agg(t)::text, '') AS j FROM cuspatlas.sensitive_read_events t`,
      )
    ).rows[0].j as string;
    expect(`${await leakTables(db)}${reads}${h.logLines.join('\n')}`).not.toContain(MARKER);
    const logged = await db.admin.query(
      `SELECT operation, resource_type FROM cuspatlas.sensitive_read_events WHERE operation LIKE 'clinical.history.%'
       GROUP BY 1, 2 ORDER BY 1`,
    );
    expect(logged.rows.map((r) => r.operation)).toEqual(
      expect.arrayContaining(['clinical.history.alerts', 'clinical.history.read']),
    );
  });

  it('S12 seam: the history reference resolves inside the caller transaction with states only, no text', async () => {
    const p = await createPatient(h, 'Synthetic History Seam');
    await record(p, [{ kind: 'medication', state: 'active', displayText: `Synthetic ${MARKER} med` }]);
    const tx = createTenantTransactionRunner(db.app);
    const ref = await tx(ctxFor(T_ALPHA, USER_A1, 'human'), (t) => resolveHistoryReference(t, p));
    expect(ref).toMatchObject({
      owner: 'C8',
      patientRef: p,
      recorded: true,
      alerts: { allergy: 'unknown', condition: 'unknown', medication: 'present' },
    });
    expect(ref.versions).toHaveLength(1);
    expect(JSON.stringify(ref)).not.toContain(MARKER);
  });

  it('MCP records replay a REST key; alerts and refusals match across surfaces', async () => {
    const p = await createPatient(h, 'Synthetic History Parity');
    const key = randomUUID();
    const body = {
      patientRef: p,
      ...staff,
      changes: [{ kind: 'condition', state: 'active', displayText: 'Synthetic Y' }],
    };
    const rest = h.ok<{ data: Version }>(await rec(body, 'a1', key), 201);
    const viaMcp = await h.mcp('a1', 'clinical_history_record_change', { ...body, idempotencyKey: key }, 201);
    expect(viaMcp.code).toBeNull();
    expect((viaMcp.body as { replayed: boolean; data: Version }).replayed).toBe(true);
    expect((viaMcp.body as { data: Version }).data.header.historyVersionRef).toBe(
      rest.data.header.historyVersionRef,
    );
    const mcpAlerts = await h.mcp('a1', 'clinical_history_alerts', { patientRef: p });
    const restAlerts = await alerts(p);
    expect((mcpAlerts.body as { data: Alerts }).data.condition).toStrictEqual(restAlerts.condition);
    const foreign = await h.mcp('b1', 'clinical_history_read', { patientRef: p });
    expect([foreign.status, foreign.code]).toStrictEqual([404, 'not_found']);
  });
});
