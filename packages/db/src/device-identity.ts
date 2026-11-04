import type { DeviceCredentialRecord, DeviceCredentialSource } from '@cuspatlas/contracts';
import type pg from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function inTransaction<T>(
  pool: pg.Pool,
  begin: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let destroy: Error | undefined;
  try {
    await client.query(begin);
    try {
      const out = await work(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch((e: Error) => {
        destroy = e;
      });
      throw err;
    }
  } finally {
    await client.query('DISCARD ALL').catch((e: Error) => {
      destroy = e;
    });
    client.release(destroy ?? false);
  }
}

/**
 * I6: live device credential lookups for the bridge audience. `load` runs read-only with only
 * `cuspatlas.auth_principal_id` set (like the membership source), so RLS limits it to the device's
 * own row and keys; it reports the device's tenant from the database, never from the caller.
 * `consumeNonce` records a single-use assertion identifier in its own committed transaction under the
 * device's tenant and actor context (so a refused request still consumes its assertion).
 */
export function createDeviceCredentialSource(pool: pg.Pool): DeviceCredentialSource {
  return {
    async load(deviceRef) {
      if (!UUID.test(deviceRef)) return null;
      return inTransaction(pool, 'BEGIN READ ONLY', async (client) => {
        await client.query(`SELECT set_config('cuspatlas.auth_principal_id', $1, true)`, [deviceRef]);
        const d = await client.query<{ tenant_id: string; state: DeviceCredentialRecord['state'] }>(
          'SELECT tenant_id, state FROM cuspatlas.imaging_devices WHERE id = $1',
          [deviceRef],
        );
        const row = d.rows[0];
        if (!row) return null;
        const k = await client.query<{ key_version: number; public_key: string }>(
          `SELECT key_version, public_key FROM cuspatlas.imaging_device_keys WHERE device_id = $1 AND state = 'active'`,
          [deviceRef],
        );
        return {
          deviceRef,
          tenantId: row.tenant_id,
          state: row.state,
          keys: k.rows.map((r) => ({ keyVersion: r.key_version, publicKey: r.public_key })),
        };
      });
    },
    async consumeNonce(record, nonce, expiresAt) {
      if (!UUID.test(nonce)) return false;
      return inTransaction(pool, 'BEGIN', async (client) => {
        await client.query(
          `SELECT set_config('cuspatlas.tenant_id', $1, true), set_config('cuspatlas.actor_id', $2, true)`,
          [record.tenantId, record.deviceRef],
        );
        const r = await client.query(
          `INSERT INTO cuspatlas.imaging_device_nonces (tenant_id, device_id, nonce, expires_at)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [record.tenantId, record.deviceRef, nonce, expiresAt],
        );
        return (r.rowCount ?? 0) === 1;
      });
    },
  };
}
