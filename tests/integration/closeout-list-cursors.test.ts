import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppointmentHarness, openAppointmentHarness } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { T_ALPHA, USER_A1, USER_A3, USER_A4 } from './support/fixtures';
import { seedMigrationScopes } from './support/migration-fixtures';

/**
 * Closeout C: the downtime-log lists (`operations.downtime.windows.list`,
 * `operations.downtime.entries.list`) and the reviewer list (`migration.reviewers.list`) page with
 * signed keyset cursors (the shared CUSPATLAS_CURSOR_KEY ring, bound to tenant, listing and filters)
 * instead of stopping at 500 rows. A page carries `nextCursor`, mirrored by the OR-01 envelope with
 * `truncated`; the last page has neither. A tampered, foreign-listing or other-tenant cursor is
 * `invalid_request`. Synthetic data only.
 */
let db: TestDatabase;
let h: AppointmentHarness;

type Page = { data: Record<string, unknown>[]; nextCursor: string | null; envelope: Record<string, unknown> };
const page = async (who: string, url: string) => h.ok<Page>(await h.call(who, 'GET', url));

/** Walks a list to its end with `limit`, checking each page's cursor and envelope; returns the keys. */
async function walk(url: string, key: string, limit: number, who = 'a1'): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const sep = url.includes('?') ? '&' : '?';
    const q = `${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const p = await page(who, `${url}${q}`);
    expect(p.data.length).toBeLessThanOrEqual(limit);
    expect(p.envelope.nextCursor).toBe(p.nextCursor);
    expect(p.envelope.truncated).toBe(p.nextCursor !== null);
    seen.push(...p.data.map((r) => r[key] as string));
    cursor = p.nextCursor;
    pages += 1;
    expect(pages).toBeLessThan(50);
  } while (cursor !== null);
  return seen;
}

const ids = async (sql: string, params: unknown[] = []) =>
  (await db.admin.query(sql, params)).rows.map((r) => r.id as string);

beforeAll(async () => {
  db = await openTestDatabase('closeout_list_cursors');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedMigrationScopes(db.admin);
  // Seven ended windows (two sharing a start instant, to exercise the tie-break) and five entries.
  const base = Date.now() - 6 * 3_600_000;
  const starts = [0, 10, 20, 20, 30, 40, 50].map((m) => new Date(base + m * 60_000).toISOString());
  let last = '';
  for (const startedAt of starts) {
    const { rows } = await db.admin.query(
      `INSERT INTO cuspatlas.ops_downtime_windows (tenant_id, scope_kind, reason_code, started_at, started_by)
       VALUES ($1, 'tenant', 'network_outage', $2, $3) RETURNING id`,
      [T_ALPHA, startedAt, USER_A1],
    );
    last = rows[0].id;
    await db.admin.query(
      `UPDATE cuspatlas.ops_downtime_windows SET state = 'ended', ended_at = started_at + interval '5 minutes',
         ended_by = $2, version = version + 1 WHERE id = $1`,
      [last, USER_A1],
    );
  }
  const lastStart = Date.parse(starts[starts.length - 1] as string);
  for (const [i, minute] of [1, 2, 2, 3, 4].entries()) {
    await db.admin.query(
      `INSERT INTO cuspatlas.ops_downtime_entries (tenant_id, window_id, entry_kind, summary, payload, paper_ref,
         captured_at, logged_by)
       VALUES ($1, $2, 'other', 'Synthetic paper record', '{}'::jsonb, $3, $4, $5)`,
      [T_ALPHA, last, `SHEET-C${i}`, new Date(lastStart + minute * 60_000).toISOString(), USER_A1],
    );
  }
  // Ended reviewer assignments on top of the seeded live ones.
  for (const p of [USER_A3, USER_A4, USER_A3, USER_A4]) {
    await db.admin.query(
      `INSERT INTO cuspatlas.migration_reviewer_assignments (tenant_id, principal_id, role, assigned_by, revoked_at)
       VALUES ($1, $2, 'financialReviewer', $3, now())`,
      [T_ALPHA, p, USER_A1],
    );
  }
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('Closeout C: cursor pages for the downtime and reviewer lists', () => {
  it('downtime windows: a multi-page walk returns every row once in the list order', async () => {
    const expected = await ids(
      'SELECT id FROM cuspatlas.ops_downtime_windows WHERE tenant_id = $1 ORDER BY started_at DESC, id',
      [T_ALPHA],
    );
    expect(expected.length).toBe(7);
    expect(await walk('/v1/operations/downtime/windows', 'windowRef', 2)).toStrictEqual(expected);
    expect(await walk('/v1/operations/downtime/windows?state=ended', 'windowRef', 3)).toStrictEqual(expected);
    // A single page that holds everything has no cursor and is complete.
    const all = await page('a1', '/v1/operations/downtime/windows');
    expect([all.data.length, all.nextCursor, all.envelope.truncated]).toStrictEqual([7, null, false]);
  });

  it('downtime entries: a multi-page walk returns every row once, oldest capture first', async () => {
    const expected = await ids(
      'SELECT id FROM cuspatlas.ops_downtime_entries WHERE tenant_id = $1 ORDER BY captured_at, id',
      [T_ALPHA],
    );
    expect(expected.length).toBe(5);
    expect(await walk('/v1/operations/downtime/entries', 'entryRef', 2)).toStrictEqual(expected);
    expect(
      await walk('/v1/operations/downtime/entries?reviewState=pending_review', 'entryRef', 1),
    ).toStrictEqual(expected);
  });

  it('reviewers: a multi-page walk returns every assignment once, oldest first (REST and MCP)', async () => {
    const expected = await ids(
      'SELECT id FROM cuspatlas.migration_reviewer_assignments WHERE tenant_id = $1 ORDER BY assigned_at, id',
      [T_ALPHA],
    );
    expect(expected.length).toBeGreaterThan(4);
    expect(await walk('/v1/migration/reviewers', 'assignmentRef', 2)).toStrictEqual(expected);
    // MCP walks the same pages with the same cursors.
    const viaMcp: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await h.mcp('a1', 'migration_reviewers_list', { limit: '2', ...(cursor ? { cursor } : {}) });
      const body = r.body as unknown as Page;
      viaMcp.push(...body.data.map((x) => x.assignmentRef as string));
      cursor = body.nextCursor;
    } while (cursor !== null);
    expect(viaMcp).toStrictEqual(expected);
  });

  it('a tampered, foreign-listing or other-tenant cursor is invalid_request', async () => {
    const first = await page('a1', '/v1/operations/downtime/windows?limit=2');
    const cursor = first.nextCursor as string;
    expect(typeof cursor).toBe('string');
    const [body, tag] = cursor.split('.') as [string, string];
    const flipped = `${body.slice(0, -1)}${body.endsWith('A') ? 'B' : 'A'}.${tag}`;
    const refused = async (who: string, url: string) => {
      const res = await h.call(who, 'GET', url);
      expect([url, res.statusCode, res.json().code]).toStrictEqual([url, 400, 'invalid_request']);
    };
    await refused('a1', `/v1/operations/downtime/windows?limit=2&cursor=${encodeURIComponent(flipped)}`);
    // A cursor is bound to its listing and its filters.
    await refused('a1', `/v1/operations/downtime/entries?limit=2&cursor=${encodeURIComponent(cursor)}`);
    await refused('a1', `/v1/migration/reviewers?limit=2&cursor=${encodeURIComponent(cursor)}`);
    await refused(
      'a1',
      `/v1/operations/downtime/windows?state=open&limit=2&cursor=${encodeURIComponent(cursor)}`,
    );
    // And to its tenant.
    await refused('b1', `/v1/operations/downtime/windows?limit=2&cursor=${encodeURIComponent(cursor)}`);
  });
});
