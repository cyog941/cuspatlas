import type pg from 'pg';

/**
 * An instant from the database clock, at the millisecond precision API instants carry.
 *
 * Use it for any instant a test compares with a database-stamped row (a statement cutoff, an `asOf`,
 * a call time right after a configuration). The host clock can read behind the PostgreSQL clock (it
 * does on the hosted Windows runner), so `new Date()` taken just after a write can land before it.
 */
export async function dbNow(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ at: Date }>(
    `SELECT date_trunc('milliseconds', clock_timestamp()) AS at`,
  );
  const at = rows[0]?.at;
  if (at === undefined) throw new Error('clock_timestamp returned no row');
  return at.toISOString();
}
