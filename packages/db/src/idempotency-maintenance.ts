import type pg from 'pg';

/**
 * Retention for `cuspatlas.command_idempotency` (7 days, recorded per row as `expires_at`). Runs on
 * a privileged maintenance connection, never on the runtime role, which has no DELETE.
 *
 * The table has FORCE ROW LEVEL SECURITY and no maintenance policy, so only a role that bypasses RLS
 * (superuser or BYPASSRLS) can see the rows. Any other role, including a non-superuser owner, would
 * delete zero rows and report success. The purge therefore checks positively that its effective role
 * bypasses RLS and refuses otherwise, so a misconfigured job fails loudly instead of reporting 0.
 * Which concrete role runs it outside tests is a deployment decision (ADR 0002). Returns rows removed.
 */
export async function purgeExpiredCommandIdempotency(client: pg.ClientBase): Promise<number> {
  const who = await client.query<{ sees_all: boolean }>(
    `SELECT (r.rolsuper OR r.rolbypassrls) AS sees_all
     FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
  );
  if (who.rows[0]?.sees_all !== true) {
    throw new Error(
      'Idempotency maintenance needs a role that bypasses row level security (superuser or BYPASSRLS); refusing to purge',
    );
  }
  const r = await client.query('DELETE FROM cuspatlas.command_idempotency WHERE expires_at <= now()');
  return r.rowCount ?? 0;
}
