import { createHash, randomUUID } from 'node:crypto';
import { isRefusalError } from '@cuspatlas/contracts';
import { createTenantTransactionRunner } from '@cuspatlas/db';
import { createMatchKeyer, requireRelationshipScope } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  createPatient,
  mergePatients,
  openAppointmentHarness,
  seedLocation,
  T_ALPHA,
  T_BETA,
  USER_A1,
} from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, USER_A3 } from './support/fixtures';
import { PATIENT_ALL } from './support/patient-fixtures';
import { SCHED_ALL } from './support/scheduling-fixtures';

/**
 * Hardening of S4-S9 after the independent review of 1b387f4 / 7929f77 (batch 2). Each case
 * reproduces the reviewed defect; synthetic data only, runtime role for every domain call.
 */
let db: TestDatabase;
let h: AppointmentHarness;
const SOON = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

beforeAll(async () => {
  db = await openTestDatabase('review_hardening_s');
  h = await openAppointmentHarness(db, { pool: 12 });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

async function relationship(
  subject: string,
  counterparty: string,
  kind = 'proxy',
  scopes = ['demographics'],
) {
  const res = await h.call('a1', 'POST', `/v1/patients/${subject}/relationships`, {
    counterpartyRef: counterparty,
    kind,
    scopes,
    ...(kind === 'proxy' ? { effectiveUntil: SOON() } : {}),
  });
  return res;
}

describe('REQUIRED 1: a revocation committed after the command transaction began is seen', () => {
  it('command transaction begun first, revoke commits, command proceeds and is denied', async () => {
    const subject = await createPatient(h, 'Synthetic Race Subject');
    const proxy = await createPatient(h, 'Synthetic Race Proxy');
    const rel = h.ok<{ data: { relationshipRef: string } }>(await relationship(subject, proxy), 201);
    const runner = createTenantTransactionRunner(db.appPool(2));
    const ctx = ctxFor(T_ALPHA, USER_A1, 'human', [...PATIENT_ALL, ...SCHED_ALL]);
    const outcome = await runner(ctx, async (tx) => {
      // The command's transaction starts now (now() is fixed from here on) ...
      await tx.query('SELECT now()');
      // ... the revocation commits on another connection while the command is waiting ...
      await new Promise((r) => setTimeout(r, 20));
      h.ok(
        await h.call(
          'a1',
          'POST',
          `/v1/patients/${subject}/relationships/${rel.data.relationshipRef}/revoke`,
          {
            expectedVersion: 1,
            reasonCode: 'patient_request',
          },
        ),
      );
      // ... and only then does the command evaluate the relationship (taking its row lock).
      return requireRelationshipScope(tx, subject, proxy, 'demographics').then(
        () => 'allowed',
        (e: unknown) => (isRefusalError(e) ? `${e.code}:${e.detail?.reason}` : 'error'),
      );
    });
    expect(outcome).toBe('forbidden:relationship_revoked');
  });
});

describe('NIT: a revocation is frozen whole', () => {
  it('the revoking actor cannot be rewritten, even by the fixture superuser', async () => {
    const subject = await createPatient(h, 'Synthetic Frozen Subject');
    const proxy = await createPatient(h, 'Synthetic Frozen Proxy');
    const rel = h.ok<{ data: { relationshipRef: string } }>(await relationship(subject, proxy), 201);
    h.ok(
      await h.call('a1', 'POST', `/v1/patients/${subject}/relationships/${rel.data.relationshipRef}/revoke`, {
        expectedVersion: 1,
        reasonCode: 'patient_request',
      }),
    );
    await expect(
      db.admin.query(
        `UPDATE cuspatlas.patient_relationships SET revoked_by = $2, version = version + 1 WHERE id = $1`,
        [rel.data.relationshipRef, USER_A3],
      ),
    ).rejects.toThrow(/revocation cannot be undone or rewritten/);
  });
});

describe('REQUIRED 2: unmerge after a lifecycle change of a moved record', () => {
  it('a relationship revoked after the merge does not block unmerge and stays revoked', async () => {
    const survivor = await createPatient(h, 'Synthetic Revoke Twin');
    const merged = await createPatient(h, 'Synthetic Revoke Twin');
    const other = await createPatient(h, 'Synthetic Revoke Other');
    const rel = h.ok<{ data: { relationshipRef: string } }>(await relationship(merged, other), 201);
    const mergeRef = await mergePatients(h, survivor, merged);
    h.ok(
      await h.call(
        'a1',
        'POST',
        `/v1/patients/${survivor}/relationships/${rel.data.relationshipRef}/revoke`,
        {
          expectedVersion: 2,
          reasonCode: 'patient_request',
        },
      ),
    );
    const res = await h.call('a1', 'POST', `/v1/patients/merges/${mergeRef}/unmerge`, {
      reasonCode: 'merged_in_error',
    });
    expect(res.statusCode).toBe(200);
    const { rows } = await db.admin.query(
      'SELECT subject_patient_id, revoked_at IS NOT NULL AS revoked FROM cuspatlas.patient_relationships WHERE id = $1',
      [rel.data.relationshipRef],
    );
    expect(rows[0]).toStrictEqual({ subject_patient_id: merged, revoked: true });
  });

  it('a content change of a moved record is a typed 409 unmerge_blocked naming it', async () => {
    const survivor = await createPatient(h, 'Synthetic Content Twin');
    const merged = await createPatient(h, 'Synthetic Content Twin');
    const other = await createPatient(h, 'Synthetic Content Other');
    const rel = h.ok<{ data: { relationshipRef: string } }>(await relationship(merged, other), 201);
    const mergeRef = await mergePatients(h, survivor, merged);
    // Superuser fixture path: a content column changes behind the merge (not possible for the runtime role).
    await db.admin.query(
      `UPDATE cuspatlas.patient_relationships SET scopes = ARRAY['demographics', 'scheduling'], version = version + 1
       WHERE id = $1`,
      [rel.data.relationshipRef],
    );
    const res = await h.call('a1', 'POST', `/v1/patients/merges/${mergeRef}/unmerge`, {
      reasonCode: 'merged_in_error',
    });
    expect([res.statusCode, res.json().code, res.json().detail]).toStrictEqual([
      409,
      'conflict',
      {
        reason: 'unmerge_blocked',
        blockingRefs: [{ kind: 'patientRelationship', ref: rel.data.relationshipRef }],
      },
    ]);
  });
});

describe('SHOULD 3: match keys are tenant-bound HMACs, never bare hashes', () => {
  it('the same synthetic identity yields different keys in two tenants and differs from SHA-256', async () => {
    const alpha = await createPatient(h, 'Synthetic Keyed');
    const beta = await createPatient(h, 'Synthetic Keyed', 'b1');
    const keys = async (id: string) =>
      (await db.admin.query('SELECT match_keys FROM cuspatlas.patients WHERE id = $1', [id])).rows[0]
        .match_keys as string[];
    const a = await keys(alpha);
    const b = await keys(beta);
    expect(a.length).toBeGreaterThan(0);
    expect(a.filter((k) => b.includes(k))).toStrictEqual([]);
    const bare = `n:${createHash('sha256').update('synthetic|synthetic keyed').digest('hex').slice(0, 32)}`;
    expect(a).not.toContain(bare);
    // The keyer itself: pepper and tenant both change the key.
    const p1 = new Uint8Array(32).fill(1);
    const p2 = new Uint8Array(32).fill(2);
    expect(createMatchKeyer(p1, T_ALPHA).key('n', 'x')).not.toBe(createMatchKeyer(p1, T_BETA).key('n', 'x'));
    expect(createMatchKeyer(p1, T_ALPHA).key('n', 'x')).not.toBe(createMatchKeyer(p2, T_ALPHA).key('n', 'x'));
    expect(() => createMatchKeyer(new Uint8Array(8), T_ALPHA)).toThrow();
  });
});

describe('SHOULD 4: crossing locks never surface as raw deadlocks', () => {
  it('concurrent A->B and B->A relationship adds all end typed (no 500)', async () => {
    const pairs = await Promise.all(
      Array.from({ length: 6 }, async (_, i) => [
        await createPatient(h, `Synthetic Cross A${i}`),
        await createPatient(h, `Synthetic Cross B${i}`),
      ]),
    );
    const results = await Promise.all(
      pairs.flatMap(([a, b]) => [
        relationship(a as string, b as string),
        relationship(b as string, a as string),
      ]),
    );
    for (const r of results) expect([201, 409]).toContain(r.statusCode);
  });

  it('two merges over crossing relationships both complete', async () => {
    const [a, b, c, d] = [
      await createPatient(h, 'Synthetic Merge North'),
      await createPatient(h, 'Synthetic Merge North'),
      await createPatient(h, 'Synthetic Merge South'),
      await createPatient(h, 'Synthetic Merge South'),
    ] as string[];
    h.ok(await relationship(b as string, d as string), 201);
    h.ok(await relationship(d as string, b as string), 201);
    const token = async (survivor: string, merged: string) => {
      const review = h.ok<{ data: { candidateRef: string; confirmationToken: string }[] }>(
        await h.call('a1', 'GET', `/v1/patients/${survivor}/duplicate-candidates`),
      );
      return review.data.find((x) => x.candidateRef === merged)?.confirmationToken;
    };
    const [t1, t2] = [await token(a as string, b as string), await token(c as string, d as string)];
    const [m1, m2] = await Promise.all([
      h.call('a1', 'POST', '/v1/patients/merges', {
        survivorRef: a,
        mergedRef: b,
        confirmationToken: t1,
        reasonCode: 'duplicate_registration',
      }),
      h.call('a1', 'POST', '/v1/patients/merges', {
        survivorRef: c,
        mergedRef: d,
        confirmationToken: t2,
        reasonCode: 'duplicate_registration',
      }),
    ]);
    expect([m1.statusCode, m2.statusCode].sort()).toStrictEqual([201, 201]);
  });

  it('two concurrent unmerges: one reverses, the other is merge_already_reversed', async () => {
    const survivor = await createPatient(h, 'Synthetic Double Undo');
    const merged = await createPatient(h, 'Synthetic Double Undo');
    const mergeRef = await mergePatients(h, survivor, merged);
    const undo = () =>
      h.call('a1', 'POST', `/v1/patients/merges/${mergeRef}/unmerge`, { reasonCode: 'merged_in_error' });
    const results = await Promise.all([undo(), undo()]);
    const sorted = results.sort((x, y) => x.statusCode - y.statusCode);
    expect(sorted.map((r) => r.statusCode)).toStrictEqual([200, 409]);
    expect(sorted[1]?.json().detail.reason).toBe('merge_already_reversed');
  });
});

describe('SHOULD 5: no same-tenant existence oracle for location-restricted callers', () => {
  it('another location resource and timezone target are 404 like missing ones; conflicts hide unreadable refs', async () => {
    // a3 is restricted to loc-north; loc-south is another location of the same tenant.
    const south = await seedLocation(h, 'loc-south');
    const missing = randomUUID();
    const read = await h.call('a3', 'GET', `/v1/scheduling/resources/${south.operatory}`);
    const readMissing = await h.call('a3', 'GET', `/v1/scheduling/resources/${missing}`);
    expect([read.statusCode, read.json().detail]).toStrictEqual([
      readMissing.statusCode,
      readMissing.json().detail,
    ]);
    expect(read.statusCode).toBe(404);
    const tz = await h.call('a3', 'POST', '/v1/scheduling/locations/loc-south/time-zone', {
      timeZone: 'America/Chicago',
      expectedVersion: 1,
    });
    const tzMissing = await h.call('a3', 'POST', '/v1/scheduling/locations/loc-nowhere/time-zone', {
      timeZone: 'America/Chicago',
      expectedVersion: 1,
    });
    expect([tz.statusCode, tz.json().code]).toStrictEqual([tzMissing.statusCode, tzMissing.json().code]);
    expect(tz.statusCode).toBe(404);
    // Availability search at a3's own location naming another location's resource: 404 like missing.
    h.ok(
      await h.call('a1', 'POST', '/v1/scheduling/locations', {
        locationRef: 'loc-north',
        displayLabel: 'Synthetic North',
        timeZone: 'America/New_York',
      }),
      201,
    );
    const search = (resourceRef: string) =>
      h.call('a3', 'POST', '/v1/availability/search', {
        locationRef: 'loc-north',
        from: '2030-03-04',
        to: '2030-03-04',
        durationMinutes: 30,
        displayTimeZone: 'America/New_York',
        requirements: [{ kind: 'operatory', resourceRef }],
      });
    const other = await search(south.operatory);
    const none = await search(missing);
    expect([other.statusCode, other.json().detail]).toStrictEqual([none.statusCode, none.json().detail]);
    expect(other.statusCode).toBe(404);
  });

  it('a time-block conflict names the blocking booking only to callers who may read bookings', async () => {
    const loc = await seedLocation(h, 'loc-oracle');
    const patient = await createPatient(h, 'Synthetic Oracle');
    const booked = h.ok<{ data: { appointmentRef: string } }>(
      await h.call('a1', 'POST', '/v1/scheduling/appointments', {
        patientRef: patient,
        locationRef: loc.locationRef,
        startsAt: '2030-03-04T15:00:00Z',
        endsAt: '2030-03-04T16:00:00Z',
        timeZone: 'America/New_York',
        provider: { kind: 'provider', resourceRef: loc.provider },
        operatory: { kind: 'operatory', resourceRef: loc.operatory },
      }),
      201,
    );
    const block = (who: string) =>
      h.call(who, 'POST', '/v1/scheduling/time-blocks', {
        locationRef: loc.locationRef,
        startsAt: '2030-03-04T15:30:00Z',
        endsAt: '2030-03-04T16:30:00Z',
        reasonCode: 'meeting',
        resources: [{ kind: 'operatory', resourceRef: loc.operatory }],
      });
    const reader = await block('a1');
    expect(reader.json().detail.conflicts[0].existingRef).toBe(booked.data.appointmentRef);
    // A writer without scheduling.read: the blocking resource, but not the blocking booking.
    const original = (
      await db.admin.query(
        'SELECT scopes, location_refs FROM cuspatlas.memberships WHERE principal_id = $1',
        [USER_A3],
      )
    ).rows[0];
    await db.admin.query(
      `UPDATE cuspatlas.memberships SET scopes = ARRAY['scheduling.write'] WHERE principal_id = $1`,
      [USER_A3],
    );
    await db.admin.query(`UPDATE cuspatlas.memberships SET location_refs = NULL WHERE principal_id = $1`, [
      USER_A3,
    ]);
    try {
      const blind = await block('a3');
      expect(blind.statusCode).toBe(409);
      expect(blind.json().detail.conflicts[0]).not.toHaveProperty('existingRef');
      expect(blind.body).not.toContain(booked.data.appointmentRef);
    } finally {
      await db.admin.query(
        'UPDATE cuspatlas.memberships SET scopes = $2::text[], location_refs = $3::text[] WHERE principal_id = $1',
        [USER_A3, original.scopes, original.location_refs],
      );
    }
  });
});

describe('NIT: a location-wide block and a booking at that location serialize', () => {
  it('concurrent location-wide block and booking: never both committed over the same window', async () => {
    const loc = await seedLocation(h, 'loc-wide');
    for (let i = 0; i < 5; i += 1) {
      const patient = await createPatient(h, `Synthetic Wide ${i}`);
      const start = new Date(Date.UTC(2030, 2, 4 + i, 15)).toISOString();
      const end = new Date(Date.UTC(2030, 2, 4 + i, 16)).toISOString();
      const [blockRes, bookRes] = await Promise.all([
        h.call('a1', 'POST', '/v1/scheduling/time-blocks', {
          locationRef: loc.locationRef,
          startsAt: start,
          endsAt: end,
          reasonCode: 'holiday',
          resources: [],
        }),
        h.call('a1', 'POST', '/v1/scheduling/appointments', {
          patientRef: patient,
          locationRef: loc.locationRef,
          startsAt: start,
          endsAt: end,
          timeZone: 'America/New_York',
          provider: { kind: 'provider', resourceRef: loc.provider },
          operatory: { kind: 'operatory', resourceRef: loc.operatory },
        }),
      ]);
      const statuses = [blockRes.statusCode, bookRes.statusCode].sort();
      expect(statuses).toStrictEqual([201, 409]);
    }
  });
});
