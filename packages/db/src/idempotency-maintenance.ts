import type pg from 'pg';

/**
 * Retention for `cuspatlas.command_idempotency` (7 days, recorded per row as `expires_at`). Runs on
 * a privileged maintenance connection (the owner/migration role), never on the runtime role, which
 * has no DELETE. Refuses to run as `cuspatlas_app` so a misconfigured job fails loudly. Note: with
 * FORCE ROW LEVEL SECURITY a non-superuser owner sees no rows unless it has BYPASSRLS or a dedicated
 * maintenance policy; that role decision belongs to the deployment ADR (0002). Returns rows removed.
 */
export async function purgeExpiredCommandIdempotency(client: pg.ClientBase): Promise<number> {
  const who = await client.query<{ u: string }>('SELECT current_user AS u');
  if (who.rows[0]?.u === 'cuspatlas_app') {
    throw new Error('Idempotency maintenance must not run as the runtime role');
  }
  const r = await client.query('DELETE FROM cuspatlas.command_idempotency WHERE expires_at <= now()');
  return r.rowCount ?? 0;
}
