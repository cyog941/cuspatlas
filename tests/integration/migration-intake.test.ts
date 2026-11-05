import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppointmentHarness, count, openAppointmentHarness } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { MARKER } from './support/marker';
import {
  intakeBody,
  legacyPackage,
  legacyTables,
  PRACTICE,
  SOURCE_SYSTEM,
  seedMigrationScopes,
} from './support/migration-fixtures';

/**
 * M2: authorised source export intake and mapping against the FABRICATED `cuspatlas-synthetic-legacy/1`
 * format. Every call goes through REST (MCP where stated) under the runtime role. Real intake stays
 * blocked on M-S1; mapping rules are recommended-pending-approval.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let profileRef: string;

const register = async (sourceSystem = SOURCE_SYSTEM, practiceRef = PRACTICE) =>
  h.ok<{ data: { profileRef: string; profileVersion: number } }>(
    await h.call('a1', 'POST', '/v1/migration/source-profiles', {
      sourceSystem,
      format: 'cuspatlas-synthetic-legacy/1',
      practiceRef,
    }),
    201,
  ).data;
const intake = (body: unknown, who = 'a1', key = randomUUID()) =>
  h.call(who, 'POST', '/v1/migration/packages', body, key);
const reviewItems = async (packageRef: string) =>
  h.ok<{
    data: {
      itemRef: string;
      category: string;
      entity: string;
      field: string | null;
      subjectKey: string;
      stagedRefs: string[];
      allowedDecisions: string[];
    }[];
  }>(await h.call('a1', 'GET', `/v1/migration/review-items?packageRef=${packageRef}`)).data;
const reason = (r: { json(): { detail?: { reason?: string } } }) => r.json().detail?.reason;

beforeAll(async () => {
  db = await openTestDatabase('migration_intake');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedMigrationScopes(db.admin);
  profileRef = (await register()).profileRef;
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('M2 source profiles', () => {
  it('a correction is a new profile version and intake against the older version is stale', async () => {
    const v1 = await register('syn-other-pms', 'syn-practice-alpha');
    const v2 = await register('syn-other-pms', 'syn-practice-alpha');
    expect([v1.profileVersion, v2.profileVersion]).toStrictEqual([1, 2]);
    const pkg = legacyPackage(legacyTables(), { sourceSystem: 'syn-other-pms' });
    const r = await intake(intakeBody(v1.profileRef, pkg));
    expect([r.statusCode, reason(r)]).toStrictEqual([409, 'stale_profile']);
    expect(await count(db, 'migration_packages')).toBe(0);
  });
  it('only synthetic source systems and practices are accepted', async () => {
    const r = await h.call('a1', 'POST', '/v1/migration/source-profiles', {
      sourceSystem: 'tab32',
      format: 'cuspatlas-synthetic-legacy/1',
      practiceRef: PRACTICE,
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('M2 intake refusals (nothing staged)', () => {
  it('refuses a package without an authorisation, from an unregistered source, or for another practice', async () => {
    const pkg = legacyPackage(legacyTables());
    const { authorisation: _a, ...noAuth } = intakeBody(profileRef, pkg);
    expect((await intake(noAuth)).statusCode).toBe(400);
    const other = await intake(
      intakeBody(profileRef, legacyPackage(legacyTables(), { sourceSystem: 'syn-unknown' })),
    );
    expect([other.statusCode, reason(other)]).toStrictEqual([422, 'unregistered_source']);
    const cross = await intake(intakeBody(profileRef, pkg, 'syn-practice-beta'));
    expect([cross.statusCode, reason(cross)]).toStrictEqual([422, 'cross_practice']);
    const crossPkg = await intake(
      intakeBody(profileRef, legacyPackage(legacyTables(), { practiceRef: 'syn-practice-beta' })),
    );
    expect([crossPkg.statusCode, reason(crossPkg)]).toStrictEqual([422, 'cross_practice']);
    expect(await count(db, 'migration_packages')).toBe(0);
    expect(await count(db, 'migration_staged_records')).toBe(0);
  });

  it('refuses a manifest that understates, misdigests, omits or adds an entity', async () => {
    const t = legacyTables();
    const cases: [ReturnType<typeof legacyPackage>, string][] = [
      [
        legacyPackage(t, {
          manifestOverride: (e) => e.map((x) => (x.name === 'patients' ? { ...x, declaredCount: 2 } : x)),
        }),
        'count_mismatch',
      ],
      [
        legacyPackage(t, {
          manifestOverride: (e) =>
            e.map((x) => (x.name === 'procedures' ? { ...x, artifactDigest: '0'.repeat(64) } : x)),
        }),
        'digest_mismatch',
      ],
      [
        legacyPackage(t, {
          manifestOverride: (e) => [
            ...e,
            { name: 'statements', declaredCount: 1, artifactDigest: 'a'.repeat(64) },
          ],
        }),
        'missing_entity',
      ],
      [
        legacyPackage(t, { manifestOverride: (e) => e.filter((x) => x.name !== 'open_claims') }),
        'undeclared_entity',
      ],
    ];
    for (const [pkg, why] of cases) {
      const r = await intake(intakeBody(profileRef, pkg));
      expect([why, r.statusCode, reason(r)]).toStrictEqual([why, 422, why]);
    }
    const truncated = legacyTables();
    truncated.patients = `${truncated.patients}"P009,Legacy`;
    const r = await intake(intakeBody(profileRef, legacyPackage(truncated)));
    expect([r.statusCode, reason(r)]).toStrictEqual([422, 'unreadable_package']);
    expect(await count(db, 'migration_packages')).toBe(0);
  });

  it('denies a member without the write scope, a revoked member and another tenant (no tenant from input)', async () => {
    const body = intakeBody(profileRef, legacyPackage(legacyTables()));
    expect((await intake(body, 'a4')).statusCode).toBe(403);
    expect((await intake(body, 'a2')).statusCode).toBe(403);
    expect((await intake(body, 'svcA1')).statusCode).toBe(403);
    // The beta member cannot see alpha's profile: hidden as missing, never staged into either tenant.
    expect((await intake(body, 'b1')).statusCode).toBe(404);
    expect(await count(db, 'migration_packages')).toBe(0);
  });
});

describe('M2 staging', () => {
  let packageRef: string;
  const tables = legacyTables({
    nameSuffix: MARKER,
    unknownField: true,
    unknownEntity: true,
    missingIds: true,
    negativeBalance: true,
    futureAppointment: true,
  });

  it('stages every row; unknown entities, fields, identifiers, terminology and money are queued', async () => {
    const patientsBefore = await count(db, 'patients');
    const journalBefore = await count(db, 'billing_journal_entries');
    const r = await intake(intakeBody(profileRef, legacyPackage(tables)));
    const res = h.ok<{
      data: { packageRef: string; state: string; alreadyStaged: boolean; stagedCount: number };
    }>(r, 201);
    packageRef = res.data.packageRef;
    expect(res.data).toMatchObject({ state: 'staged', alreadyStaged: false, stagedCount: 18 });
    // Intake writes no patient and no ledger row (M3 applies through the owning commands only).
    expect(await count(db, 'patients')).toBe(patientsBefore);
    expect(await count(db, 'billing_journal_entries')).toBe(journalBefore);
    const state = h.ok<{
      data: { entities: { entity: string; mapped: boolean; staged: number; withIssue: number }[] };
    }>(await h.call('a4', 'GET', `/v1/migration/packages/state?packageRef=${packageRef}`)).data;
    expect(state.entities).toContainEqual({ entity: 'recall_notes', mapped: false, staged: 1, withIssue: 1 });
    expect(state.entities).toContainEqual({ entity: 'patients', mapped: true, staged: 5, withIssue: 2 });
    const items = await reviewItems(packageRef);
    const by = (c: string) => items.filter((i) => i.category === c);
    expect(by('unmapped_entity').map((i) => i.entity)).toStrictEqual(['recall_notes']);
    expect(by('unknown_field').map((i) => i.field)).toStrictEqual(['legacy_flag']);
    // Two rows with an empty identifier are two separate items, never collapsed into one record.
    expect(by('missing_source_id').map((i) => i.subjectKey)).toStrictEqual(['row:4', 'row:5']);
    expect(new Set(by('missing_source_id').flatMap((i) => i.stagedRefs)).size).toBe(2);
    // Terminology is queued per distinct legacy code, never mapped to a clinical code automatically.
    expect(by('terminology').map((i) => i.subjectKey)).toStrictEqual(['code:L-EXAM', 'code:L-PROPHY']);
    expect(by('terminology').find((i) => i.subjectKey === 'code:L-PROPHY')?.stagedRefs).toHaveLength(2);
    expect(by('monetary_semantics')).toHaveLength(1);
    expect(by('future_appointment')).toHaveLength(1);
    expect(by('identity')).toHaveLength(0);
  });

  it('the same package twice returns the same staged package (different key, MCP too)', async () => {
    const before = await count(db, 'migration_staged_records');
    const again = h.ok<{ data: { packageRef: string; alreadyStaged: boolean } }>(
      await intake(intakeBody(profileRef, legacyPackage(tables))),
      201,
    );
    expect(again.data).toMatchObject({ packageRef, alreadyStaged: true });
    const viaMcp = await h.mcp('a1', 'migration_packages_intake', {
      ...intakeBody(profileRef, legacyPackage(tables)),
      idempotencyKey: randomUUID(),
    });
    expect([viaMcp.status, (viaMcp.body as { data: { packageRef: string } }).data.packageRef]).toStrictEqual([
      200,
      packageRef,
    ]);
    expect(await count(db, 'migration_staged_records')).toBe(before);
    const rest = await reviewItems(packageRef);
    const mcpItems = await h.mcp('a4', 'migration_review_items_list', { packageRef });
    expect(mcpItems.body.data).toStrictEqual(rest);
  });

  it('a review decision is recorded once, only from the decisions the item allows', async () => {
    const items = await reviewItems(packageRef);
    const field = items.find((i) => i.category === 'unknown_field');
    const money = items.find((i) => i.category === 'monetary_semantics');
    if (!field || !money) throw new Error('fixture items missing');
    const resolve = (body: Record<string, unknown>, who = 'a1') =>
      h.call(who, 'POST', '/v1/migration/review-items/resolve', { packageRef, ...body });
    const wrong = await resolve({ itemRef: field.itemRef, decision: 'distinct', reasonCode: 'reviewed' });
    expect([wrong.statusCode, reason(wrong)]).toStrictEqual([422, 'decision_not_allowed']);
    expect(
      (await resolve({ itemRef: field.itemRef, decision: 'exclude', reasonCode: 'reviewed' }, 'a4'))
        .statusCode,
    ).toBe(403);
    expect(
      (await resolve({ itemRef: field.itemRef, decision: 'exclude', reasonCode: 'reviewed' }, 'b1'))
        .statusCode,
    ).toBe(404);
    h.ok(await resolve({ itemRef: field.itemRef, decision: 'exclude', reasonCode: 'reviewed' }));
    const twice = await resolve({ itemRef: field.itemRef, decision: 'archiveOnly', reasonCode: 'reviewed' });
    expect([twice.statusCode, reason(twice)]).toStrictEqual([409, 'already_resolved']);
    h.ok(
      await resolve({ itemRef: money.itemRef, decision: 'acceptProposal', reasonCode: 'credit_confirmed' }),
    );
    // Only the decision changed: a review item can never be edited or deleted under the runtime role.
    await expect(
      db.app.query('DELETE FROM cuspatlas.migration_review_items WHERE id = $1', [field.itemRef]),
    ).rejects.toThrow();
  });

  it('the marker in source names never reaches audit, outbox, attempt, idempotency or read logs', async () => {
    for (const t of [
      'audit_events',
      'outbox_events',
      'security_attempt_events',
      'command_idempotency',
      'sensitive_read_events',
    ]) {
      const { rows } = await db.admin.query(
        `SELECT coalesce(json_agg(t)::text, '') AS j FROM cuspatlas.${t} t`,
      );
      expect([t, rows[0].j.includes(MARKER)]).toStrictEqual([t, false]);
    }
    expect(h.logLines.join('\n')).not.toContain(MARKER);
  });
});
