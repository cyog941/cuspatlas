import type { ActorContext } from '@cuspatlas/contracts';
import type pg from 'pg';

/** Synthetic identities only. No real names, practices or patients. */
export const T_ALPHA = '10000000-0000-4000-8000-00000000000a';
export const T_BETA = '10000000-0000-4000-8000-00000000000b';

export const USER_A1 = '20000000-0000-4000-8000-0000000000a1'; // human, alpha, read/write/approve, all locations
export const USER_A2 = '20000000-0000-4000-8000-0000000000a2'; // human, alpha, REVOKED
export const USER_A3 = '20000000-0000-4000-8000-0000000000a3'; // human, alpha, read/write, location loc-north only
export const USER_A4 = '20000000-0000-4000-8000-0000000000a4'; // human, alpha, read only
export const SVC_A1 = '30000000-0000-4000-8000-0000000000a1'; // service, alpha, read/write/approve
export const USER_B1 = '20000000-0000-4000-8000-0000000000b1'; // human, beta, read/write
export const SVC_B1 = '30000000-0000-4000-8000-0000000000b1'; // service, beta, read/write
export const USER_NONE = '20000000-0000-4000-8000-0000000000ff'; // no principal row

export const TASK_A = '40000000-0000-4000-8000-0000000000a1';
export const TASK_A_NORTH = '40000000-0000-4000-8000-0000000000a2';
export const TASK_A_SOUTH = '40000000-0000-4000-8000-0000000000a3';
export const TASK_B = '40000000-0000-4000-8000-0000000000b1';

const RW = ['syntheticTasks.read', 'syntheticTasks.write'];
const RWA = [...RW, 'syntheticTasks.approve'];

/** Seeds through the superuser connection (fixture creation is an explicit test-only path). */
export async function seedTenancy(admin: pg.Pool): Promise<void> {
  await admin.query(
    `INSERT INTO cuspatlas.tenants (id, slug) VALUES ($1, 'tenant-alpha'), ($2, 'tenant-beta')`,
    [T_ALPHA, T_BETA],
  );
  const principals: [string, string, string][] = [
    [USER_A1, 'human', 'user-a1'],
    [USER_A2, 'human', 'user-a2'],
    [USER_A3, 'human', 'user-a3'],
    [USER_A4, 'human', 'user-a4'],
    [SVC_A1, 'service', 'svc-a1'],
    [USER_B1, 'human', 'user-b1'],
    [SVC_B1, 'service', 'svc-b1'],
  ];
  for (const [id, kind, handle] of principals) {
    await admin.query('INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, $2, $3)', [
      id,
      kind,
      handle,
    ]);
  }
  const memberships: [string, string, string[], string[] | null, boolean][] = [
    [T_ALPHA, USER_A1, RWA, null, false],
    [T_ALPHA, USER_A2, RWA, null, true],
    [T_ALPHA, USER_A3, RW, ['loc-north'], false],
    [T_ALPHA, USER_A4, ['syntheticTasks.read'], null, false],
    [T_ALPHA, SVC_A1, RWA, null, false],
    [T_BETA, USER_B1, RW, null, false],
    [T_BETA, SVC_B1, RW, null, false],
  ];
  for (const [tenant, principal, scopes, locations, revoked] of memberships) {
    await admin.query(
      `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes, location_refs, revoked_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() ELSE NULL END)`,
      [tenant, principal, scopes, locations, revoked],
    );
  }
  const tasks: [string, string, string, string | null, string][] = [
    [TASK_A, T_ALPHA, 'alpha task', null, USER_A1],
    [TASK_A_NORTH, T_ALPHA, 'alpha north task', 'loc-north', USER_A1],
    [TASK_A_SOUTH, T_ALPHA, 'alpha south task', 'loc-south', USER_A1],
    [TASK_B, T_BETA, 'beta task', null, USER_B1],
  ];
  for (const [id, tenant, label, loc, by] of tasks) {
    await admin.query(
      'INSERT INTO cuspatlas.synthetic_tasks (id, tenant_id, label, location_ref, created_by) VALUES ($1, $2, $3, $4, $5)',
      [id, tenant, label, loc, by],
    );
  }
}

let n = 0;
/** Builds a context the way the server would; tests forge variants of it to prove denial. */
export function ctxFor(
  tenantId: string,
  actorId: string,
  principal: 'human' | 'service',
  scopes: readonly string[] = RWA,
): ActorContext {
  n += 1;
  return {
    tenantId,
    actorId,
    principal,
    scopes,
    sessionId: `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    correlationId: `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  };
}
