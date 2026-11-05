import type { TenantTransaction } from '@cuspatlas/contracts';

/**
 * The domain's current-time sources. Rule: domain code takes current time from the database for any
 * comparison with a stored fact. Stored facts are stamped by PostgreSQL (`DEFAULT now()`,
 * `clock_timestamp()`, `now() + make_interval(...)`), and the Node host clock can run ahead of or
 * behind it (it runs behind on the hosted Windows runner). Comparing an application instant with a
 * database-stamped column gives a skew-sized window where a fact recorded a moment ago looks absent,
 * expired or still in the future. `scripts/clock-guard.test.ts` refuses new bare `Date.now()` /
 * `new Date()` uses outside its audited allowlist.
 *
 * Which clock:
 * - `transactionNow` is `now()`, the transaction start. Use it only in a short transaction, where the
 *   comparison mirrors a SQL `now()` predicate in the same code path (budget periods a meter resets
 *   with `now()`) and for freshness stamps of a transaction's reads. A future instant written late in
 *   a long transaction (after a lock wait, store I/O or a batch) must not start from it: it can be
 *   past at commit (clock audit review).
 * - `databaseNow` is `clock_timestamp()`, wall time at the statement, truncated to the millisecond
 *   precision API instants carry. Use it for "current" reads of facts other transactions may have
 *   committed after this one began, for an `asOf` a read reports, for checking that a
 *   client-supplied instant is not in the future, and for wall-clock checks and future instants
 *   (leases, backoffs) written after a lock wait or a slow phase. Audit and security-attempt rows are
 *   stamped with `clock_timestamp()` in SQL. A SQL comparison of a stored column against an
 *   API (millisecond) instant truncates the column with `date_trunc('milliseconds', ...)` too.
 */
export async function transactionNow(tx: Pick<TenantTransaction, 'query'>): Promise<Date> {
  const { rows } = await tx.query<{ at: Date }>('SELECT now() AS at');
  const at = rows[0]?.at;
  if (at === undefined) throw new Error('now() returned no row');
  return at;
}

/** Statement wall time from the database clock, at API millisecond precision (see `transactionNow`). */
export async function databaseNow(tx: Pick<TenantTransaction, 'query'>): Promise<Date> {
  const { rows } = await tx.query<{ at: Date }>(`SELECT date_trunc('milliseconds', clock_timestamp()) AS at`);
  const at = rows[0]?.at;
  if (at === undefined) throw new Error('clock_timestamp() returned no row');
  return at;
}
