import type pg from 'pg';
import { SVC_A1, SVC_B1, T_ALPHA, USER_A1, USER_A2, USER_A3, USER_A4, USER_B1 } from './fixtures';

/**
 * Patient-workstream scopes layered on top of seedTenancy. Synthetic principals only. Kept in a
 * separate support file so the foundation fixtures stay unchanged.
 */
export const PATIENT_RW = ['patients.read', 'patients.write'] as const;
export const PATIENT_ALL = [...PATIENT_RW, 'patients.merge', 'patients.mergeReconcile'] as const;

/** Human in alpha holding only synthetic-task scopes: a role "downgraded" out of the patient module. */
export const USER_A5 = '20000000-0000-4000-8000-0000000000a5';
/** Human in alpha with read/write/merge but not the elevated reconcile scope. */
export const USER_A6 = '20000000-0000-4000-8000-0000000000a6';

export async function seedPatientScopes(admin: pg.Pool): Promise<void> {
  const grant = (principal: string, scopes: readonly string[]) =>
    admin.query('UPDATE cuspatlas.memberships SET scopes = scopes || $2::text[] WHERE principal_id = $1', [
      principal,
      scopes,
    ]);
  await grant(USER_A1, PATIENT_ALL);
  await grant(USER_A2, PATIENT_ALL); // membership is revoked
  await grant(USER_A3, PATIENT_RW); // loc-north only
  await grant(USER_A4, ['patients.read']);
  await grant(SVC_A1, [...PATIENT_RW, 'patients.merge']);
  await grant(USER_B1, PATIENT_ALL);
  await grant(SVC_B1, PATIENT_RW);
  for (const [id, handle, scopes] of [
    [USER_A5, 'user-a5', ['syntheticTasks.read']],
    [USER_A6, 'user-a6', [...PATIENT_RW, 'patients.merge']],
  ] as const) {
    await admin.query(`INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'human', $2)`, [
      id,
      handle,
    ]);
    await admin.query(
      'INSERT INTO cuspatlas.memberships (tenant_id, principal_id, scopes) VALUES ($1, $2, $3)',
      [T_ALPHA, id, scopes],
    );
  }
}

type Json = Record<string, unknown>;

/** Minimum valid create body: a known legal name and a day-precision synthetic birth date. */
export function patientBody(given: string, overrides: Json = {}): Json {
  return {
    legalName: { known: true, given, family: 'Synthetic' },
    birthDate: { known: true, value: '2001-02-03', precision: 'day' },
    ...overrides,
  };
}

export const phone = (value: string, preference = 'preferred') => ({
  channel: 'phone',
  use: 'home',
  value,
  preference,
});

/** Every table text a caller-controlled value could leak into, as one string for marker scans. */
export async function leakSurface(admin: pg.Pool): Promise<string> {
  const parts: string[] = [];
  for (const t of [
    'audit_events',
    'outbox_events',
    'security_attempt_events',
    'command_idempotency',
    'sensitive_read_events',
  ]) {
    const { rows } = await admin.query(`SELECT coalesce(json_agg(t)::text, '') AS j FROM cuspatlas.${t} t`);
    parts.push(rows[0].j);
  }
  return parts.join('\n');
}
