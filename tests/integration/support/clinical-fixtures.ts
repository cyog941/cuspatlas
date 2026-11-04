import type pg from 'pg';
import { SVC_A1, SVC_B1, T_ALPHA, T_BETA, USER_A1, USER_A2, USER_A3, USER_A4, USER_B1 } from './fixtures';

/**
 * Clinical-workstream scopes and author profiles layered on top of seedTenancy (superuser fixture
 * path, test-only). Synthetic principals only; no clinical role here is a real person's.
 */
export const CLINICAL_READ = 'clinical.read';
export const CLINICAL_WRITE = 'clinical.write';
export const CLINICAL_RW = [CLINICAL_READ, CLINICAL_WRITE] as const;

/** Human in alpha with clinical read/write but no clinical author profile (front desk). */
export const USER_A7 = '20000000-0000-4000-8000-0000000000a7';

/**
 * a1: clinical rw, dentist; a2: the same but REVOKED; a3: clinical rw at loc-north only, hygienist;
 * a4: clinical read only (downgraded); a7: clinical rw without a profile; svc-a1: clinical rw (a
 * service principal: never a clinical author); b1 and svc-b1: clinical rw in tenant beta, b1 dentist.
 */
export async function seedClinicalScopes(admin: pg.Pool): Promise<void> {
  const add: [string, readonly string[]][] = [
    [USER_A1, CLINICAL_RW],
    [USER_A2, CLINICAL_RW],
    [USER_A3, CLINICAL_RW],
    [USER_A4, [CLINICAL_READ]],
    [SVC_A1, CLINICAL_RW],
    [USER_B1, CLINICAL_RW],
    [SVC_B1, CLINICAL_RW],
  ];
  for (const [principal, scopes] of add) {
    await admin.query(
      'UPDATE cuspatlas.memberships SET scopes = scopes || $2::text[] WHERE principal_id = $1',
      [principal, scopes],
    );
  }
  await admin.query(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'human', 'user-a7') ON CONFLICT DO NOTHING`,
    [USER_A7],
  );
  await admin.query(
    `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [T_ALPHA, USER_A7, CLINICAL_RW],
  );
  for (const [tenant, actor, role, credential] of [
    [T_ALPHA, USER_A1, 'dentist', 'SYN-CRED-A1'],
    [T_ALPHA, USER_A2, 'dentist', null],
    [T_ALPHA, USER_A3, 'hygienist', null],
    [T_BETA, USER_B1, 'dentist', null],
  ] as const) {
    await admin.query(
      `INSERT INTO cuspatlas.clinical_author_profiles (tenant_id, actor_id, role, credential_ref, defined_by, updated_by)
       VALUES ($1, $2, $3, $4, $2, $2)`,
      [tenant, actor, role, credential],
    );
  }
}

/** Configured disposition codes (synthetic tenant configuration; no practice decision). */
export async function seedDispositions(
  admin: pg.Pool,
  tenantId: string,
  codes: readonly string[],
): Promise<void> {
  for (const code of codes) {
    await admin.query(
      'INSERT INTO cuspatlas.clinical_encounter_dispositions (tenant_id, disposition_code) VALUES ($1, $2)',
      [tenantId, code],
    );
  }
}
