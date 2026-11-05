import type { TestDatabase } from './db';
import { T_ALPHA, USER_A1 } from './fixtures';

/**
 * Seeds a B9 practice fee schedule version (synthetic codes and amounts) as the database owner, for
 * C12 tests whose estimates now take every line fee from B9. Each call appends the next version of
 * the tenant-wide practice schedule (created on first use); the latest version effective on the
 * service date wins, so a later call with new amounts reprices later estimates.
 */
export async function seedPracticeFees(
  db: TestDatabase,
  items: readonly (readonly [codeRef: string, minor: number])[],
  opts: { tenantId?: string; createdBy?: string; effectiveFrom?: string; currency?: string } = {},
): Promise<{ scheduleRef: string; versionRef: string }> {
  const tenantId = opts.tenantId ?? T_ALPHA;
  const createdBy = opts.createdBy ?? USER_A1;
  const scheduleRef = 'syn-fee-practice';
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO cuspatlas.billing_fee_schedules (tenant_id, schedule_ref, purpose, currency, created_by)
       VALUES ($1, $2, 'practice', $3, $4) ON CONFLICT (tenant_id, schedule_ref) DO NOTHING`,
      [tenantId, scheduleRef, opts.currency ?? 'USD', createdBy],
    );
    const { rows: s } = await client.query<{ id: string; next: number }>(
      `SELECT s.id, coalesce((SELECT max(v.version_no) FROM cuspatlas.billing_fee_schedule_versions v
                              WHERE v.schedule_id = s.id), 0) + 1 AS next
       FROM cuspatlas.billing_fee_schedules s WHERE s.tenant_id = $1 AND s.schedule_ref = $2`,
      [tenantId, scheduleRef],
    );
    const schedule = s[0];
    if (!schedule) throw new Error('fee schedule not seeded');
    const { rows: v } = await client.query<{ id: string }>(
      `INSERT INTO cuspatlas.billing_fee_schedule_versions
         (tenant_id, schedule_id, version_no, effective_from, item_count, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, schedule.id, schedule.next, opts.effectiveFrom ?? '2026-01-01', items.length, createdBy],
    );
    const versionRef = v[0]?.id;
    if (!versionRef) throw new Error('fee schedule version not seeded');
    for (const [codeRef, minor] of items) {
      await client.query(
        `INSERT INTO cuspatlas.billing_fee_schedule_items (tenant_id, version_id, code_ref, fee_minor)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, versionRef, codeRef, minor],
      );
    }
    await client.query('COMMIT');
    return { scheduleRef, versionRef };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
