import type pg from 'pg';
import { T_ALPHA, USER_A1, USER_A2, USER_A3, USER_B1 } from './fixtures';

/**
 * Note-signing scopes (C9/C10) layered on top of seedClinicalScopes (superuser fixture path,
 * test-only). Synthetic principals only.
 */
export const CLINICAL_SIGN = 'clinical.sign';
export const CLINICAL_OVERSIGHT = 'clinical.oversight';

/** Human dentist in alpha with clinical read/write/sign but no oversight scope. */
export const USER_A8 = '20000000-0000-4000-8000-0000000000a8';
/** Human dentist in alpha with clinical read/write/sign and the clinical-oversight scope. */
export const USER_A9 = '20000000-0000-4000-8000-0000000000a9';

/**
 * a1, a2 (revoked), a3 (loc-north hygienist) and b1 gain clinical.sign; a4 stays read-only; a8 and a9
 * are new alpha dentists (a9 also holds clinical.oversight). svc-a1 gets clinical.sign so the
 * human-only rule, not a missing scope, is what refuses it.
 */
export async function seedNoteScopes(admin: pg.Pool): Promise<void> {
  for (const principal of [USER_A1, USER_A2, USER_A3, USER_B1, '30000000-0000-4000-8000-0000000000a1']) {
    await admin.query(
      'UPDATE cuspatlas.memberships SET scopes = scopes || ARRAY[$2]::text[] WHERE principal_id = $1',
      [principal, CLINICAL_SIGN],
    );
  }
  for (const [actor, handle, scopes] of [
    [USER_A8, 'user-a8', ['clinical.read', 'clinical.write', CLINICAL_SIGN]],
    [USER_A9, 'user-a9', ['clinical.read', 'clinical.write', CLINICAL_SIGN, CLINICAL_OVERSIGHT]],
  ] as const) {
    await admin.query(
      `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'human', $2) ON CONFLICT DO NOTHING`,
      [actor, handle],
    );
    await admin.query(
      `INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [T_ALPHA, actor, scopes],
    );
    await admin.query(
      `INSERT INTO cuspatlas.clinical_author_profiles (tenant_id, actor_id, role, credential_ref, defined_by, updated_by)
       VALUES ($1, $2, 'dentist', NULL, $2, $2) ON CONFLICT DO NOTHING`,
      [T_ALPHA, actor],
    );
  }
}
