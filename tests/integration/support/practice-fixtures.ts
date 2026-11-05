import { expect } from 'vitest';
import { seedBillingScopes } from './billing-fixtures';
import { seedClinicalScopes } from './clinical-fixtures';
import { seedEngagementScopes } from './engagement-fixtures';
import { type ImagingStack, ingestVia, pngBytes } from './imaging-fixtures';
import {
  intakeBody,
  legacyPackage,
  PRACTICE,
  SOURCE_SYSTEM,
  seedMigrationScopes,
} from './migration-fixtures';
import { patientBody } from './patient-fixtures';
import { seedSchedulingScopes } from './scheduling-fixtures';

const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;

export async function seedPracticeScopes(s: ImagingStack): Promise<void> {
  await seedSchedulingScopes(s.db.admin);
  await seedClinicalScopes(s.db.admin);
  await seedEngagementScopes(s.db.admin);
  await seedBillingScopes(s.db.admin);
  await seedMigrationScopes(s.db.admin);
}

/**
 * A small synthetic practice across S, I, B and M (workstream M batch 2 drills and parity): one
 * patient with an associated image, and a migrated patient with a historical appointment and an
 * opening balance (journal entries through the B1 primitive). Returns the references the drills use.
 */
export async function seedSyntheticPractice(
  s: ImagingStack,
  tag: string,
): Promise<{ patientRef: string; packageRef: string; objectRef: string }> {
  await seedPracticeScopes(s);
  const patientRef = data<{ patientRef: string }>(
    await s.command('owner', '/v1/patients', patientBody(`Practice ${tag}`)),
  ).patientRef;
  const a = await ingestVia(s, pngBytes(9400 + tag.length, 8, 8), { intendedPatientRef: patientRef });
  const assoc = await s.command('owner', `/v1/imaging/objects/${a.objectRef}/association`, {
    patientRef,
    basis: 'operatorSelected',
  });
  expect(assoc.status).toBe(201);
  const profileRef = data<{ profileRef: string }>(
    await s.command('owner', '/v1/migration/source-profiles', {
      sourceSystem: SOURCE_SYSTEM,
      format: 'cuspatlas-synthetic-legacy/1',
      practiceRef: PRACTICE,
    }),
  ).profileRef;
  const packageRef = data<{ packageRef: string }>(
    await s.command(
      'owner',
      '/v1/migration/packages',
      intakeBody(
        profileRef,
        legacyPackage({
          patients:
            'patient_id,last_name,first_name,birth_date,phone,guarantor_id\nD001,Drill,Rowe,1970-01-05,5550300001,G1\n',
          appointments:
            'appt_id,patient_id,start_local,time_zone,duration_min,status\nDA1,D001,2025-05-02 09:00,America/New_York,60,completed\n',
          ledger_balances:
            'balance_id,account_id,patient_id,balance_minor,currency,as_of\nDB1,G1,D001,2500,USD,2026-10-31\n',
        }),
      ),
    ),
  ).packageRef;
  const planDigest = data<{ planDigest: string }>(
    await s.inject('owner', 'GET', `/v1/migration/imports/plan?packageRef=${packageRef}`),
  ).planDigest;
  const applied = await s.command('owner', '/v1/migration/imports/apply', {
    packageRef,
    expectedPlanDigest: planDigest,
    batchSize: 50,
  });
  expect(data<{ state: string }>(applied).state).toBe('complete');
  return { patientRef, packageRef, objectRef: a.objectRef };
}
