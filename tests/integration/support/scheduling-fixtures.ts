import type pg from 'pg';
import { SVC_A1, SVC_B1, T_ALPHA, USER_A1, USER_A2, USER_A3, USER_A4, USER_B1 } from './fixtures';

/** Synthetic principal with tenant-alpha membership but no scheduling scope at all. */
export const USER_A5 = '20000000-0000-4000-8000-0000000000a5';

export const SCHED_READ = 'scheduling.read';
export const SCHED_WRITE = 'scheduling.write';
export const ADMIN_CONFIGURE = 'admin.configure';
export const SCHED_ALL = [SCHED_READ, SCHED_WRITE, ADMIN_CONFIGURE];

/**
 * Adds the scheduling scopes on top of seedTenancy (superuser fixture path, test-only):
 * a1 admin + scheduler (all locations), a2 the same but REVOKED, a3 admin + scheduler for loc-north
 * only, a4 scheduling read only (downgraded role), a5 no scheduling scope, svc-a1 scheduler without
 * admin.configure, b1 and svc-b1 everything in tenant beta.
 */
export async function seedSchedulingScopes(admin: pg.Pool): Promise<void> {
  const add: [string, string[]][] = [
    [USER_A1, SCHED_ALL],
    [USER_A2, SCHED_ALL],
    [USER_A3, SCHED_ALL],
    [USER_A4, [SCHED_READ]],
    [SVC_A1, [SCHED_READ, SCHED_WRITE]],
    [USER_B1, SCHED_ALL],
    [SVC_B1, SCHED_ALL],
  ];
  for (const [principal, scopes] of add) {
    await admin.query(
      'UPDATE cuspatlas.memberships SET scopes = scopes || $2::text[] WHERE principal_id = $1',
      [principal, scopes],
    );
  }
  await admin.query(`INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'human', 'user-a5')`, [
    USER_A5,
  ]);
  await admin.query(
    `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, ARRAY['syntheticTasks.read'])`,
    [T_ALPHA, USER_A5],
  );
}

/**
 * Test-only busy fixture: an occupancy row standing in for a future booking (S10 will create these
 * through the booking command). Written through the superuser fixture path, never through a UI.
 */
export async function insertBookingFixture(
  admin: pg.Pool,
  o: { tenantId: string; resourceRef: string; startsAt: string; endsAt: string; createdBy: string },
): Promise<string> {
  const { rows } = await admin.query<{ source_id: string }>(
    `INSERT INTO cuspatlas.scheduling_occupancy (tenant_id, resource_id, location_id, during, source_kind,
       source_id, created_by)
     SELECT r.tenant_id, r.id, r.location_id, tstzrange($3::timestamptz, $4::timestamptz, '[)'), 'appointment',
       gen_random_uuid(), $5
     FROM cuspatlas.scheduling_resources r WHERE r.id = $2 AND r.tenant_id = $1
     RETURNING source_id`,
    [o.tenantId, o.resourceRef, o.startsAt, o.endsAt, o.createdBy],
  );
  const id = rows[0]?.source_id;
  if (!id) throw new Error('booking fixture insert failed');
  return id;
}
