import { ESCALATION_CANDIDATES_SQL } from '@cuspatlas/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedLocation } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { type EngagementHarness, email, openEngagementHarness } from './support/engagement-fixtures';
import { T_ALPHA, USER_A1 } from './support/fixtures';

/**
 * Closeout E3: the reply-escalation keyset orders and compares by the millisecond instant of the episode
 * start. date_trunc on timestamptz is STABLE, so no index can hold it; the episode lookup now orders by
 * the IMMUTABLE wrapper cuspatlas.instant_ms, which an expression index on thread_messages holds, and
 * the keyset compares the value the lookup returns. The walk returns exactly what the previous query
 * returned. Synthetic data only.
 */
const QUEUES = ['front_desk', 'billing', 'clinical_team'];
const DAYS = [1, 1, 1];
const THREADS = 700;

/** The query before Closeout E (date_trunc on the joined instant), kept as the reference result. */
const PREVIOUS_SQL = `SELECT t.id, t.queue, t.version, ep.created_at AS episode_at, l.time_zone, ep.id AS trigger_id
       FROM cuspatlas.message_threads t
       JOIN cuspatlas.scheduling_locations l ON l.id = t.location_id AND l.tenant_id = t.tenant_id
       JOIN LATERAL (SELECT m.id, m.created_at FROM cuspatlas.thread_messages m
       WHERE m.thread_id = t.id AND m.author_kind = 'portal'
         AND m.created_at > coalesce((SELECT max(s.created_at) FROM cuspatlas.thread_messages s
                                      WHERE s.thread_id = t.id AND s.author_kind = 'staff'), '-infinity'::timestamptz)
       ORDER BY m.created_at, m.id LIMIT 1) ep ON true
       JOIN unnest($3::text[], $4::int[]) AS pol(queue, days) ON pol.queue = t.queue
       WHERE t.state = 'open' AND t.awaiting = 'practice'
         AND ep.created_at <= $2::timestamptz - make_interval(days => pol.days)
         AND ($1::text[] IS NULL OR l.location_ref = ANY ($1::text[]))
         AND ($5::timestamptz IS NULL OR (date_trunc('milliseconds', ep.created_at), t.id) > ($5::timestamptz, $6::uuid))
         AND NOT EXISTS (SELECT 1 FROM cuspatlas.thread_reply_escalations e
           WHERE e.thread_id = t.id AND e.trigger_message_id = ep.id)
       ORDER BY date_trunc('milliseconds', ep.created_at), t.id LIMIT 500`;

let db: TestDatabase;
let h: EngagementHarness;

/** Runs work as the runtime role inside the alpha tenant context (RLS applies). */
async function asTenant<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.app.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `SELECT set_config('cuspatlas.tenant_id', $1, true), set_config('cuspatlas.actor_id', $2, true)`,
      [T_ALPHA, USER_A1],
    );
    return await work(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

const params = async (c: pg.PoolClient, after: { at: Date; id: string } | null) => {
  const now = (await c.query<{ now: Date }>('SELECT now()')).rows[0]?.now;
  return [null, now, QUEUES, DAYS, after?.at ?? null, after?.id ?? null];
};

type Candidate = { id: string; trigger_id: string; episode_at: Date; at_ms?: Date };

async function walk(sql: string): Promise<string[]> {
  return asTenant(async (c) => {
    const out: string[] = [];
    let after: { at: Date; id: string } | null = null;
    for (let batch = 0; batch < 20; batch += 1) {
      const { rows }: { rows: Candidate[] } = await c.query<Candidate>(sql, await params(c, after));
      out.push(...rows.map((r) => `${r.id}:${r.trigger_id}`));
      const last: Candidate | undefined = rows[rows.length - 1];
      if (rows.length < 500 || !last) break;
      // Closeout E review: the current query returns the keyset value it compares (at_ms); the
      // previous one is walked as it was, by the driver's millisecond Date of the episode start.
      after = { at: last.at_ms ?? last.episode_at, id: last.id };
    }
    return out;
  });
}

beforeAll(async () => {
  db = await openTestDatabase('reply_escalation_keyset');
  h = await openEngagementHarness(db);
  await seedLocation(h, 'loc-keyset');
  const personRef = await h.person('Synthetic Keyset Adult', [email('e3.keyset')]);
  const ids = await db.admin.query<{ patient_id: string; location_id: string }>(
    `SELECT (SELECT id FROM cuspatlas.patients WHERE tenant_id = $1 AND id::text = $2) AS patient_id,
       (SELECT id FROM cuspatlas.scheduling_locations WHERE tenant_id = $1 AND location_ref = 'loc-keyset')
         AS location_id`,
    [T_ALPHA, personRef],
  );
  const { patient_id, location_id } = ids.rows[0] ?? {};
  expect(patient_id).toBeTruthy();
  expect(location_id).toBeTruthy();
  // THREADS open threads awaiting the practice; three share each episode millisecond (microseconds
  // apart), so the keyset breaks ties by thread id across a batch boundary. Each has an earlier staff
  // message and 20 portal messages, the first of which starts the episode. Bulk fixture rows skip the
  // author-side triggers (session_replication_role), as the other escalation fixtures backdate rows.
  const seed = await db.admin.connect();
  try {
    await seed.query('SET session_replication_role = replica');
    await seed.query(
      `WITH th AS (
       INSERT INTO cuspatlas.message_threads (tenant_id, patient_id, location_id, topic, queue, awaiting,
         opened_via, opened_by, created_at, last_message_at)
       SELECT $1, $2, $3, 'general', (ARRAY['front_desk', 'billing', 'clinical_team'])[1 + g % 3], 'practice',
         'staff', $4, now() - interval '20 days', now() - interval '10 days'
       FROM generate_series(0, $5::int - 1) g
       RETURNING id),
     numbered AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS g FROM th),
     ep AS (
       SELECT id, date_trunc('milliseconds', now() - interval '10 days')
         + make_interval(secs => (g / 3) * 0.001) + make_interval(secs => (g % 3) * 0.000001) AS at
       FROM numbered)
     INSERT INTO cuspatlas.thread_messages (tenant_id, thread_id, author_id, author_kind, body, created_at)
     SELECT $1, ep.id, $4, 'staff', 'Synthetic staff note', ep.at - interval '1 day' FROM ep
     UNION ALL
     SELECT $1, ep.id, $4, 'portal', 'Synthetic portal note', ep.at + make_interval(secs => k)
     FROM ep, generate_series(0, 19) k`,
      [T_ALPHA, patient_id, location_id, USER_A1, THREADS],
    );
  } finally {
    await seed.query('RESET session_replication_role');
    seed.release();
  }
  await db.admin.query('ANALYZE cuspatlas.thread_messages');
  await db.admin.query('ANALYZE cuspatlas.message_threads');
}, 240_000);
afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('Closeout E3: the reply-escalation keyset has a matching expression index', () => {
  it('date_trunc on timestamptz is not immutable; the wrapper is, and agrees with it in any session zone', async () => {
    const vol = await db.admin.query<{ fn: string; v: string }>(
      `SELECT p.oid::regprocedure::text AS fn, p.provolatile AS v FROM pg_proc p
       WHERE p.oid IN ('pg_catalog.date_trunc(text, timestamptz)'::regprocedure,
                       'cuspatlas.instant_ms(timestamptz)'::regprocedure)`,
    );
    const by = Object.fromEntries(vol.rows.map((r) => [r.fn, r.v]));
    expect(by['date_trunc(text,timestamp with time zone)']).toBe('s');
    expect(by['cuspatlas.instant_ms(timestamp with time zone)']).toBe('i');
    for (const zone of ['UTC', 'Asia/Kathmandu', 'America/St_Johns', 'Europe/Amsterdam']) {
      const c = await db.admin.connect();
      try {
        await c.query(`SET timezone = '${zone}'`);
        const diff = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM cuspatlas.thread_messages
           WHERE cuspatlas.instant_ms(created_at) IS DISTINCT FROM date_trunc('milliseconds', created_at)`,
        );
        expect(diff.rows[0]?.n).toBe(0);
      } finally {
        await c.query('RESET timezone');
        c.release();
      }
    }
  });

  it('the index holds the expression the keyset orders by', async () => {
    const idx = await db.admin.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'cuspatlas' AND indexname = 'thread_messages_episode_ms'`,
    );
    expect(idx.rows[0]?.indexdef).toMatch(
      /\(tenant_id, thread_id, author_kind, cuspatlas\.instant_ms\(created_at\), created_at, id\)/,
    );
    expect(ESCALATION_CANDIDATES_SQL).not.toMatch(/date_trunc/);
    expect(ESCALATION_CANDIDATES_SQL).toMatch(
      /ORDER BY cuspatlas\.instant_ms\(m\.created_at\), m\.created_at, m\.id LIMIT 1/,
    );
    expect(ESCALATION_CANDIDATES_SQL).toMatch(/ORDER BY ep\.at_ms, t\.id LIMIT 500/);
  });

  it('the planner serves the episode lookup from that index on a seeded table', async () => {
    const plan = await asTenant(async (c) => {
      const { rows } = await c.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN ${ESCALATION_CANDIDATES_SQL}`,
        await params(c, null),
      );
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toMatch(/Index (Only )?Scan using thread_messages_episode_ms/);
  });

  it('returns the keyset value it compares: the millisecond-truncated episode instant', async () => {
    const check = await asTenant(async (c) => {
      const p = await params(c, null);
      const { rows } = await c.query<Candidate>(ESCALATION_CANDIDATES_SQL, p);
      // Compared in the database, at full precision: never through the driver's truncation.
      const exact = await c.query<{ n: number; bad: number; micro: number }>(
        `SELECT count(*)::int AS n,
           count(*) FILTER (WHERE c.at_ms IS DISTINCT FROM date_trunc('milliseconds', m.created_at))::int AS bad,
           count(*) FILTER (WHERE m.created_at <> date_trunc('milliseconds', m.created_at))::int AS micro
         FROM (${ESCALATION_CANDIDATES_SQL}) c JOIN cuspatlas.thread_messages m ON m.id = c.trigger_id`,
        p,
      );
      return { rows, exact: exact.rows[0] };
    });
    expect(check.rows).toHaveLength(500);
    expect(check.exact).toMatchObject({ n: 500, bad: 0 });
    // The seed has sub-millisecond episode starts, so truncation is exercised.
    expect(check.exact?.micro).toBeGreaterThan(0);
    for (const r of check.rows) {
      expect(r.at_ms).toBeInstanceOf(Date);
      expect(r.at_ms?.getTime()).toBe(Math.floor(r.episode_at.getTime()));
    }
    expect(ESCALATION_CANDIDATES_SQL).toMatch(/ep.at_ms AS at_ms/);
  });

  it('walks the same candidates in the same order as the previous query, across batches and ties', async () => {
    const previous = await walk(PREVIOUS_SQL);
    expect(previous).toHaveLength(THREADS);
    expect(await walk(ESCALATION_CANDIDATES_SQL)).toStrictEqual(previous);
  });
});
