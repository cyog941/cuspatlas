import { randomUUID } from 'node:crypto';
import type pg from 'pg';
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
import { seedClinicalScopes, seedDispositions, USER_A7 } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { USER_A6 } from './support/patient-fixtures';

/**
 * Hardening of C5 and C8 after the independent review of 58bb6b5 (synthetic data only): merge-probe
 * timing under interleaving, independent database enforcement (closed encounters, merge-only
 * relinks, authorship snapshots), history changes routed to the item's own stream, the two-person
 * rule for clinical author profiles, low-privilege unmerge, each probe term, typed concurrency
 * conflicts and deterministic ordering. Every denial runs under the runtime role.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let a6: string;
let a7: string;
let locationId: string;
const LOC = 'loc-hardening';
const ENC = '/v1/clinical/encounters';
const CHANGES = '/v1/clinical/history/changes';
const staff = { provenance: 'staff', reportedBy: 'clinician' };

beforeAll(async () => {
  db = await openTestDatabase('clinical_hardening');
  h = await openAppointmentHarness(db, { mcp: false });
  await seedClinicalScopes(db.admin);
  await seedDispositions(db.admin, T_ALPHA, ['completed_as_planned']);
  await seedLocation(h, LOC);
  a6 = await h.issuer.issue({ sub: USER_A6, tid: T_ALPHA });
  a7 = await h.issuer.issue({ sub: USER_A7, tid: T_ALPHA });
  locationId = (
    await db.admin.query('SELECT id FROM cuspatlas.scheduling_locations WHERE location_ref = $1', [LOC])
  ).rows[0].id;
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

/** A runtime-role transaction with tenant and actor context (the application's own role). */
async function asApp<T>(work: (c: pg.PoolClient) => Promise<T>, actor = USER_A1): Promise<T> {
  const client = await db.app.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
    await client.query(`SELECT set_config('cuspatlas.actor_id', $1, true)`, [actor]);
    const out = await work(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code ?? 'error',
  );

async function encounter(patientRef: string) {
  return h.ok<{ data: { encounter: { encounterRef: string; version: number } } }>(
    await h.call('a1', 'POST', ENC, { patientRef, locationRef: LOC }),
    201,
  ).data.encounter;
}
async function close(e: { encounterRef: string; version: number }) {
  h.ok(
    await h.call('a1', 'POST', `${ENC}/${e.encounterRef}/close`, {
      expectedVersion: e.version,
      dispositionCode: 'completed_as_planned',
    }),
  );
}
async function record(patientRef: string, changes: unknown[]) {
  return h.ok<{
    data: {
      header: { historyVersionRef: string; streamRef: string };
      changes: { itemRef: string; change: { changeRef: string } }[];
    };
  }>(await h.call('a1', 'POST', CHANGES, { patientRef, ...staff, changes }), 201).data;
}
const unmerge = (
  mergeRef: string,
  who = 'a1',
  body: Record<string, unknown> = { reasonCode: 'merged_in_error' },
) => h.call(who, 'POST', `/v1/patients/merges/${mergeRef}/unmerge`, body);
const reviewRequired = async (mergeRef: string) => {
  const res = await unmerge(mergeRef);
  expect([res.statusCode, res.json().detail]).toStrictEqual([
    422,
    { reason: 'reconciliation_review_required' },
  ]);
};

describe('finding 1: merge-probe timing', () => {
  it('an encounter opened in a transaction begun before the merge but committed after it is a post-merge fact', async () => {
    const survivor = await createPatient(h, 'Synthetic Hardening Timing');
    const merged = await createPatient(h, 'Synthetic Hardening Timing');
    const client = await db.app.connect();
    let mergeRef = '';
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
      await client.query(`SELECT set_config('cuspatlas.actor_id', $1, true)`, [USER_A1]);
      await client.query('SELECT now()');
      mergeRef = await mergePatients(h, survivor, merged);
      await client.query(
        `INSERT INTO cuspatlas.clinical_encounters (tenant_id, subject_patient_id, location_id, opened_by, opened_by_role,
           opened_by_credential_ref) VALUES ($1, $2, $3, $4, 'dentist', 'SYN-CRED-A1')`,
        [T_ALPHA, survivor, locationId, USER_A1],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await reviewRequired(mergeRef);
  });

  it('an assignment appended in a transaction begun before the merge is a post-merge fact', async () => {
    const survivor = await createPatient(h, 'Synthetic Hardening Assign');
    const merged = await createPatient(h, 'Synthetic Hardening Assign');
    const e = await encounter(survivor);
    const client = await db.app.connect();
    let mergeRef = '';
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('cuspatlas.tenant_id', $1, true)`, [T_ALPHA]);
      await client.query(`SELECT set_config('cuspatlas.actor_id', $1, true)`, [USER_A1]);
      await client.query('SELECT now()');
      mergeRef = await mergePatients(h, survivor, merged);
      await client.query(
        `INSERT INTO cuspatlas.clinical_encounter_assignments (tenant_id, encounter_id, location_id, sequence, role,
           resource_id, assigned_by, assigned_by_role, assigned_by_credential_ref)
         VALUES ($1, $2, $3, 1, 'staff', NULL, $4, 'dentist', 'SYN-CRED-A1')`,
        [T_ALPHA, e.encounterRef, locationId, USER_A1],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await reviewRequired(mergeRef);
  });
});

describe('finding 2: independent database enforcement under the runtime role', () => {
  it('no assignment, history version, verification or review can name a closed encounter', async () => {
    const p = await createPatient(h, 'Synthetic Hardening Closed');
    const v = await record(p, [{ kind: 'allergy', state: 'active', displayText: 'Synthetic allergen H' }]);
    const e = await encounter(p);
    await close(e);
    const stream = v.header.streamRef;
    const change = v.changes[0]?.change.changeRef;
    for (const [sql, params] of [
      [
        `INSERT INTO cuspatlas.clinical_encounter_assignments (tenant_id, encounter_id, location_id, sequence, role,
           resource_id, assigned_by, assigned_by_role, assigned_by_credential_ref)
         VALUES ($1, $2, $3, 1, 'staff', NULL, $4, 'dentist', 'SYN-CRED-A1')`,
        [T_ALPHA, e.encounterRef, locationId, USER_A1],
      ],
      [
        `INSERT INTO cuspatlas.clinical_history_versions (tenant_id, stream_id, sequence, provenance, reported_by,
           encounter_id, recorded_by, recorded_by_role, recorded_by_credential_ref)
         VALUES ($1, $2, 2, 'staff', 'clinician', $3, $4, 'dentist', 'SYN-CRED-A1')`,
        [T_ALPHA, stream, e.encounterRef, USER_A1],
      ],
      [
        `INSERT INTO cuspatlas.clinical_history_verifications (tenant_id, change_id, encounter_id, verified_by,
           verified_by_role, verified_by_credential_ref) VALUES ($1, $2, $3, $4, 'dentist', 'SYN-CRED-A1')`,
        [T_ALPHA, change, e.encounterRef, USER_A1],
      ],
      [
        `INSERT INTO cuspatlas.clinical_history_reviews (tenant_id, encounter_id, allergy_outcome, reviewed_by,
           reviewed_by_role, reviewed_by_credential_ref) VALUES ($1, $2, 'confirmed', $3, 'dentist', 'SYN-CRED-A1')`,
        [T_ALPHA, e.encounterRef, USER_A1],
      ],
    ] as const) {
      expect([sql, await codeOf(asApp((c) => c.query(sql, [...params])))]).toStrictEqual([sql, '42501']);
    }
  });

  it('a patient reference moves only with a recorded merge or its reversal', async () => {
    const p = await createPatient(h, 'Synthetic Hardening Relink');
    const other = await createPatient(h, 'Synthetic Hardening Relink Other');
    await encounter(p);
    await record(p, [{ kind: 'condition', state: 'active', displayText: 'Synthetic condition H' }]);
    for (const table of [
      'clinical_encounters',
      'clinical_history_streams',
      'clinical_charts',
      'clinical_perio_streams',
      'clinical_treatment_plans',
    ]) {
      if (table === 'clinical_charts') {
        h.ok(
          await h.call('a1', 'POST', '/v1/clinical/chart/entries', {
            patientRef: p,
            provenance: 'recorded',
            tooth: { system: 'universal', code: '3' },
            kind: 'condition',
            findingRef: 'SYN-COND-H',
          }),
          201,
        );
      }
      if (table === 'clinical_treatment_plans')
        h.ok(await h.call('a1', 'POST', '/v1/clinical/treatment-plans', { patientRef: p }), 201);
      if (table === 'clinical_perio_streams') {
        await db.admin.query(
          `INSERT INTO cuspatlas.clinical_perio_streams (tenant_id, subject_patient_id, origin_patient_id, created_by)
           VALUES ($1, $2, $2, $3)`,
          [T_ALPHA, p, USER_A1],
        );
      }
      const sql = `UPDATE cuspatlas.${table} SET subject_patient_id = $1, version = version + 1 WHERE subject_patient_id = $2`;
      expect([table, await codeOf(asApp((c) => c.query(sql, [other, p])))]).toStrictEqual([table, '42501']);
    }
  });

  it('an authorship snapshot must equal the author’s active profile at write time', async () => {
    const p = await createPatient(h, 'Synthetic Hardening Author');
    const e = await encounter(p);
    const v = await record(p, [{ kind: 'allergy', state: 'active', displayText: 'Synthetic allergen J' }]);
    for (const [sql, params] of [
      [
        `INSERT INTO cuspatlas.clinical_encounters (tenant_id, subject_patient_id, location_id, opened_by, opened_by_role,
           opened_by_credential_ref) VALUES ($1, $2, $3, $4, 'hygienist', 'SYN-CRED-A1')`,
        [T_ALPHA, p, locationId, USER_A1],
      ],
      [
        `INSERT INTO cuspatlas.clinical_encounter_assignments (tenant_id, encounter_id, location_id, sequence, role,
           resource_id, assigned_by, assigned_by_role, assigned_by_credential_ref)
         VALUES ($1, $2, $3, 1, 'staff', NULL, $4, 'dentist', NULL)`,
        [T_ALPHA, e.encounterRef, locationId, USER_A1],
      ],
      [
        `INSERT INTO cuspatlas.clinical_history_versions (tenant_id, stream_id, sequence, provenance, reported_by,
           recorded_by, recorded_by_role, recorded_by_credential_ref)
         VALUES ($1, $2, 2, 'staff', 'clinician', $3, 'assistant', 'SYN-CRED-A1')`,
        [T_ALPHA, v.header.streamRef, USER_A1],
      ],
      [
        `UPDATE cuspatlas.clinical_encounters SET state = 'closed', disposition_code = 'completed_as_planned',
           closed_by = $2, closed_by_role = 'hygienist', closed_by_credential_ref = NULL, closed_at = now(),
           version = version + 1 WHERE id = $1`,
        [e.encounterRef, USER_A1],
      ],
    ] as const) {
      expect([sql, await codeOf(asApp((c) => c.query(sql, [...params])))]).toStrictEqual([sql, '42501']);
    }
  });
});

describe('finding 3: a history change after a merge is recorded in the item’s own stream', () => {
  it('routes the survivor’s change into the merged stream, refuses mixed streams, and unmerges cleanly', async () => {
    const survivor = await createPatient(h, 'Synthetic Hardening Stream');
    const merged = await createPatient(h, 'Synthetic Hardening Stream');
    const own = await record(survivor, [
      { kind: 'condition', state: 'active', displayText: 'Synthetic condition S' },
    ]);
    const theirs = await record(merged, [
      { kind: 'allergy', state: 'active', displayText: 'Synthetic allergen M' },
    ]);
    const itemRef = theirs.changes[0]?.itemRef as string;
    const mergeRef = await mergePatients(h, survivor, merged);
    const changed = await record(survivor, [{ itemRef, state: 'resolved', reasonCode: 'no_longer_present' }]);
    expect(changed.header.streamRef).toBe(theirs.header.streamRef);
    const mixed = await h.call('a1', 'POST', CHANGES, {
      patientRef: survivor,
      ...staff,
      changes: [
        { itemRef, state: 'active' },
        { itemRef: own.changes[0]?.itemRef, state: 'resolved', reasonCode: 'no_longer_present' },
      ],
    });
    expect([mixed.statusCode, mixed.json().detail]).toStrictEqual([
      422,
      { violations: [{ pointer: '/changes', rule: 'mixedHistoryStreams' }] },
    ]);
    // The database ties a change to a version of its item's own stream.
    const sql = `INSERT INTO cuspatlas.clinical_history_changes (tenant_id, version_id, item_id, item_sequence, state,
                   reason_code) VALUES ($1, $2, $3, 9, 'resolved', 'no_longer_present')`;
    expect(await codeOf(asApp((c) => c.query(sql, [T_ALPHA, own.header.historyVersionRef, itemRef])))).toBe(
      '42501',
    );
    const back = await unmerge(mergeRef, 'a1', {
      reasonCode: 'reconciliation_review',
      reconciliationReviewRef: 'synthetic-review-hardening',
    });
    expect(back.statusCode).toBe(200);
    const read = async (p: string) =>
      h.ok<{ data: { items: { itemRef: string; current: { state: string } }[] } }>(
        await h.call('a1', 'GET', `/v1/clinical/patients/${p}/history`),
      ).data.items;
    expect((await read(merged)).map((i) => [i.itemRef, i.current.state])).toStrictEqual([
      [itemRef, 'resolved'],
    ]);
    expect((await read(survivor)).map((i) => i.itemRef)).toStrictEqual([own.changes[0]?.itemRef]);
  });
});

describe('finding 5: a clinical author profile is defined by someone else', () => {
  it('an admin cannot define or change their own profile; the database refuses it too', async () => {
    const res = await h.call('a1', 'POST', '/v1/clinical/authors', {
      actorRef: USER_A1,
      role: 'dentist',
      expectedVersion: 1,
    });
    expect([res.statusCode, res.json().code, res.json().detail]).toStrictEqual([
      403,
      'forbidden',
      { reason: 'clinical_author_self_definition' },
    ]);
    const { rows } = await db.admin.query(
      'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
      [res.headers['x-correlation-id']],
    );
    expect(rows.map((r) => r.reason_code)).toStrictEqual(['clinical_author_self_definition']);
    const self = `UPDATE cuspatlas.clinical_author_profiles SET role = 'dentist', version = version + 1,
                    updated_by = $1 WHERE actor_id = $1`;
    expect(await codeOf(asApp((c) => c.query(self, [USER_A1])))).toBe('42501');
  });
});

describe('finding 6: low-privilege unmerge and each probe term', () => {
  it('a member without the reconciliation scope gets 403 unmerge_review_required after a clinical fact', async () => {
    const survivor = await createPatient(h, 'Synthetic Hardening LowPriv');
    const merged = await createPatient(h, 'Synthetic Hardening LowPriv');
    const mergeRef = await mergePatients(h, survivor, merged);
    await record(survivor, [{ kind: 'allergy', state: 'active', displayText: 'Synthetic allergen L' }]);
    const res = await unmerge(mergeRef, a6);
    expect([res.statusCode, res.json().code]).toStrictEqual([403, 'forbidden']);
    const { rows } = await db.admin.query(
      'SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1',
      [res.headers['x-correlation-id']],
    );
    expect(rows.map((r) => r.reason_code)).toStrictEqual(['unmerge_review_required']);
  });

  it('a history version alone after the merge requires the review', async () => {
    const survivor = await createPatient(h, 'Synthetic Hardening ProbeV');
    const merged = await createPatient(h, 'Synthetic Hardening ProbeV');
    const mergeRef = await mergePatients(h, survivor, merged);
    await record(survivor, [{ kind: 'medication', state: 'active', displayText: 'Synthetic medication P' }]);
    await reviewRequired(mergeRef);
  });

  it('a verification alone after the merge requires the review', async () => {
    const survivor = await createPatient(h, 'Synthetic Hardening ProbeF');
    const merged = await createPatient(h, 'Synthetic Hardening ProbeF');
    const v = await record(survivor, [
      { kind: 'allergy', state: 'active', displayText: 'Synthetic allergen P' },
    ]);
    const mergeRef = await mergePatients(h, survivor, merged);
    h.ok(
      await h.call('a1', 'POST', `/v1/clinical/history/items/${v.changes[0]?.itemRef}/verifications`, {
        expectedChangeRef: v.changes[0]?.change.changeRef,
      }),
      201,
    );
    await reviewRequired(mergeRef);
  });

  it('a review attestation alone after the merge requires the review', async () => {
    const survivor = await createPatient(h, 'Synthetic Hardening ProbeR');
    const merged = await createPatient(h, 'Synthetic Hardening ProbeR');
    const e = await encounter(survivor);
    const mergeRef = await mergePatients(h, survivor, merged);
    h.ok(
      await h.call('a1', 'POST', `${ENC}/${e.encounterRef}/history-reviews`, { medication: 'confirmed' }),
      201,
    );
    await reviewRequired(mergeRef);
  });
});

describe('finding 7 and nits: typed concurrency conflicts, ordering and clearing', () => {
  it('two concurrent verifications of one change give one success and one already_verified', async () => {
    const p = await createPatient(h, 'Synthetic Hardening Verify');
    const v = await record(p, [{ kind: 'allergy', state: 'active', displayText: 'Synthetic allergen V' }]);
    const url = `/v1/clinical/history/items/${v.changes[0]?.itemRef}/verifications`;
    const body = { expectedChangeRef: v.changes[0]?.change.changeRef };
    const results = await Promise.all([h.call('a1', 'POST', url, body), h.call('a3', 'POST', url, body)]);
    expect(results.map((r) => r.statusCode).sort()).toStrictEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)?.json().detail?.reason).toBe('already_verified');
  });

  it('two concurrent first definitions of one profile give one success and one typed conflict', async () => {
    const body = { actorRef: USER_A7, role: 'assistant' };
    const results = await Promise.all(
      [1, 2].map(() => h.call('a1', 'POST', '/v1/clinical/authors', body, randomUUID())),
    );
    expect(results.map((r) => r.statusCode).sort()).toStrictEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)?.json().detail?.reason).toBe('author_profile_exists');
    expect((await h.call(a7, 'GET', '/v1/clinical/author-context')).json().data.resolvable).toBe(true);
  });

  it('a version lists its changes in request order', async () => {
    const p = await createPatient(h, 'Synthetic Hardening Order');
    const names = ['Synthetic A', 'Synthetic B', 'Synthetic C', 'Synthetic D', 'Synthetic E'];
    const v = await record(
      p,
      names.map((displayText) => ({ kind: 'allergy', state: 'active', displayText })),
    );
    const read = h.ok<{ data: { changes: { change: { displayText: string } }[] } }>(
      await h.call('a1', 'GET', `/v1/clinical/history/versions/${v.header.historyVersionRef}`),
    ).data;
    expect(read.changes.map((c) => c.change.displayText)).toStrictEqual(names);
  });

  it('a change can clear a nullable field explicitly', async () => {
    const p = await createPatient(h, 'Synthetic Hardening Clear');
    const v = await record(p, [
      {
        kind: 'medication',
        state: 'active',
        displayText: 'Synthetic medication C',
        detailText: 'Synthetic dose',
      },
    ]);
    const cleared = await record(p, [{ itemRef: v.changes[0]?.itemRef, state: 'active', detailText: null }]);
    const detail = h.ok<{
      data: { changes: { change: { detailText: string | null; displayText: string } }[] };
    }>(await h.call('a1', 'GET', `/v1/clinical/history/versions/${cleared.header.historyVersionRef}`)).data
      .changes[0]?.change;
    expect([detail?.detailText, detail?.displayText]).toStrictEqual([null, 'Synthetic medication C']);
  });
});
