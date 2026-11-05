import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedLocation } from './support/appointment-fixtures';
import { seedClinicalScopes } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { type EngagementHarness, openEngagementHarness } from './support/engagement-fixtures';
import { USER_A1 } from './support/fixtures';

/**
 * Integration seams between producers that only coexist on codex/backend-integration (synthetic data
 * only). E6 recall enrollment consumes S16's due list, and S16's completed-procedure basis reads C14:
 * E enrolls procedure-due patients, lists them by the procedure's encounter location, and keeps S16's
 * clinical-read gate (a caller without clinical.read cannot enroll from or list such a policy).
 */
let db: TestDatabase;
let h: EngagementHarness;
let loc: { locationRef: string; provider: string; operatory: string };

beforeAll(async () => {
  db = await openTestDatabase('integration_seams');
  h = await openEngagementHarness(db, { mcp: false });
  await seedClinicalScopes(db.admin);
  loc = await seedLocation(h, 'loc-integration-seams');
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

async function rendered(patientRef: string, codeRef: string, dateOfService: string) {
  const e = h.ok<{ data: { encounter: { encounterRef: string; version: number } } }>(
    await h.call('a1', 'POST', '/v1/clinical/encounters', { patientRef, locationRef: loc.locationRef }),
    201,
  ).data.encounter;
  h.ok(
    await h.call('a1', 'POST', `/v1/clinical/encounters/${e.encounterRef}/assignments`, {
      expectedVersion: e.version,
      role: 'treating_provider',
      assignee: { kind: 'provider', resourceRef: loc.provider },
    }),
    201,
  );
  return h.ok<{ data: { procedureRef: string } }>(
    await h.call(
      'a1',
      'POST',
      `/v1/clinical/encounters/${e.encounterRef}/procedures`,
      { sequence: 1, dateOfService, renderingProviderRef: loc.provider, codeRef },
      randomUUID(),
    ),
    201,
  ).data.procedureRef;
}

describe('E6 recall enrollment over the S16 completed-procedure basis (C14)', () => {
  it('enrolls procedure-due patients, lists them by encounter location, and keeps the clinical-read gate', async () => {
    const category = 'integ-perio';
    h.ok(
      await h.call('a1', 'POST', '/v1/scheduling/recall/policies', {
        category,
        intervalMonths: 6,
        basis: 'completed_procedure',
        procedureCodeRefs: ['SYN-PROC-INTEG'],
      }),
      201,
    );
    const due = await h.person('Synthetic Integration Procedure Due', []);
    const other = await h.person('Synthetic Integration Other Code', []);
    const procedure = await rendered(due, 'SYN-PROC-INTEG', '2026-01-15');
    await rendered(other, 'SYN-PROC-OTHER', '2026-01-15');
    const body = { category, asOf: '2026-11-01T12:00:00Z', patientRefs: [due, other] };
    const first = h.ok<{
      data: { enrolled: number; skipped: { ref: string; reason: string; exclusion: string }[] };
    }>(await h.call('a1', 'POST', '/v1/communications/recall-enrollments', body), 201).data;
    expect(first.enrolled).toBe(1);
    expect(first.skipped).toStrictEqual([{ ref: other, reason: 'recall_not_due', exclusion: 'no_baseline' }]);
    const list = h.ok<{ data: { patientRef: string; lastEventRef: string; dueDate: string }[] }>(
      await h.call('a1', 'GET', `/v1/communications/recall-enrollments?category=${category}`),
    ).data;
    expect(list.map((e) => [e.patientRef, e.lastEventRef, e.dueDate])).toStrictEqual([
      [due, procedure, '2026-07-15'],
    ]);
    // Without clinical.read the procedure-based policy is a clinical read the caller may not make.
    await db.admin.query(
      `UPDATE cuspatlas.memberships SET scopes = array_remove(scopes, 'clinical.read') WHERE principal_id = $1`,
      [USER_A1],
    );
    try {
      const enroll = await h.call('a1', 'POST', '/v1/communications/recall-enrollments', body);
      expect([enroll.statusCode, enroll.json().code]).toStrictEqual([403, 'forbidden']);
      const read = await h.call('a1', 'GET', `/v1/communications/recall-enrollments?category=${category}`);
      expect([read.statusCode, read.json().code]).toStrictEqual([403, 'forbidden']);
    } finally {
      await db.admin.query(
        `UPDATE cuspatlas.memberships SET scopes = scopes || ARRAY['clinical.read'] WHERE principal_id = $1`,
        [USER_A1],
      );
    }
  });
});
