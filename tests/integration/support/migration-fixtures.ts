import { createHash } from 'node:crypto';
import type pg from 'pg';
import { SVC_A1, SVC_B1, USER_A1, USER_A2, USER_A3, USER_A4, USER_B1 } from './fixtures';

/**
 * Workstream M fixtures. `cuspatlas-synthetic-legacy/1` is a FABRICATED source format shaped like a
 * legacy PMS export (CSV tables plus a manifest of counts and SHA-256 digests). Every value below is
 * synthetic and deterministic; no real export, vendor format or patient is represented.
 *
 * Scopes: a1 everything (financial reviewer); a3 read/write/sign-off (operations reviewer, a second
 * human); a4 read only (downgraded); a5 none; a2 everything but REVOKED; svc-a1 read/write (the import
 * worker; never a sign-off); b1/svc-b1 in tenant beta.
 */
export const MIGRATION_ALL = ['migration.read', 'migration.write', 'migration.signoff'];

export async function seedMigrationScopes(admin: pg.Pool): Promise<void> {
  const add: [string, string[]][] = [
    [USER_A1, MIGRATION_ALL],
    [USER_A2, MIGRATION_ALL],
    [USER_A3, MIGRATION_ALL],
    [USER_A4, ['migration.read']],
    [SVC_A1, ['migration.read', 'migration.write']],
    [USER_B1, MIGRATION_ALL],
    [SVC_B1, ['migration.read', 'migration.write']],
  ];
  for (const [principal, scopes] of add) {
    await admin.query(
      'UPDATE cuspatlas.memberships SET scopes = scopes || $2::text[] WHERE principal_id = $1',
      [principal, scopes],
    );
  }
}

export const SOURCE_SYSTEM = 'syn-legacy-pms';
export const PRACTICE = 'syn-practice-alpha';
export const PRODUCED_AT = '2026-10-31T23:00:00Z';

const csv = (rows: readonly (readonly string[])[]) => `${rows.map((r) => r.join(',')).join('\n')}\n`;

export interface LegacyOptions {
  /** Appended to every given name (e.g. the leak marker). */
  readonly nameSuffix?: string;
  /** Adds a column the adapter does not know to the patients table. */
  readonly unknownField?: boolean;
  /** Adds a table the source profile does not know. */
  readonly unknownEntity?: boolean;
  /** Adds two patient rows with an empty source identifier. */
  readonly missingIds?: boolean;
  /** Adds a negative ledger balance (ambiguous monetary semantics). */
  readonly negativeBalance?: boolean;
  /** Adds a future scheduled appointment. */
  readonly futureAppointment?: boolean;
  /** Adds a second row for P003 with the same name and birth date (a within-source duplicate). */
  readonly sourceDuplicate?: boolean;
  /** Distinguishes otherwise identical packages (a re-export). */
  readonly exportSeq?: number;
}

/** The synthetic legacy tables (deterministic). */
export function legacyTables(o: LegacyOptions = {}): Record<string, string> {
  const s = o.nameSuffix ?? '';
  const patientHeader = ['patient_id', 'last_name', 'first_name', 'birth_date', 'phone', 'guarantor_id'];
  if (o.unknownField) patientHeader.push('legacy_flag');
  const patientRows: string[][] = [
    ['P001', 'Legacy', `Avery${s}`, '1980-04-02', '5550100001', 'G1'],
    ['P002', 'Legacy', `Blake${s}`, '2012-06-15', '5550100001', 'G1'],
    ['P003', 'Legacy', `Casey${s}`, '1975-11', '5550100003', 'G2'],
  ];
  if (o.sourceDuplicate) patientRows.push(['P003B', 'Legacy', `Casey${s}`, '1975-11', '5550100099', 'G2']);
  if (o.missingIds) {
    patientRows.push(['', 'Legacy', `Drew${s}`, '1990-01-01', '5550100004', 'G3']);
    patientRows.push(['', 'Legacy', `Emery${s}`, '1991-01-01', '5550100005', 'G3']);
  }
  if (o.unknownField) for (const r of patientRows) r.push('Y');
  const appointments: string[][] = [
    ['appt_id', 'patient_id', 'start_local', 'time_zone', 'duration_min', 'status'],
    ['A001', 'P001', '2026-03-02 09:00', 'America/New_York', '60', 'completed'],
    ['A002', 'P002', '2026-04-10 14:30', 'America/New_York', '30', 'broken'],
  ];
  if (o.futureAppointment)
    appointments.push(['A003', 'P001', '2026-12-01 10:00', 'America/New_York', '60', 'scheduled']);
  const tables: Record<string, string> = {
    patients: csv([patientHeader, ...patientRows]),
    appointments: csv(appointments),
    procedures: csv([
      ['proc_id', 'patient_id', 'legacy_code', 'service_date', 'fee_minor'],
      ['X001', 'P001', 'L-PROPHY', '2026-03-02', '9500'],
      ['X002', 'P001', 'L-EXAM', '2026-03-02', '6000'],
      ['X003', 'P002', 'L-PROPHY', '2026-04-01', '9500'],
    ]),
    ledger_balances: csv([
      ['balance_id', 'account_id', 'patient_id', 'balance_minor', 'currency', 'as_of'],
      ['B001', 'G1', 'P001', '12500', 'USD', '2026-10-31'],
      ['B002', 'G1', 'P002', '4000', 'USD', ''],
      ['B003', 'G2', 'P003', '7700', 'USD', '2026-10-31'],
      ...(o.negativeBalance ? [['B004', 'G2', 'P003', '-1500', 'USD', '2026-10-31']] : []),
    ]),
    unapplied_credits: csv([
      ['payment_id', 'account_id', 'patient_id', 'amount_minor', 'currency', 'received_on'],
      ['C001', 'G1', 'P001', '2000', 'USD', '2026-09-15'],
    ]),
    open_claims: csv([
      ['claim_id', 'patient_id', 'payer_name', 'state', 'outstanding_minor', 'currency'],
      ['K001', 'P002', 'Synthetic Payer', 'submitted', '18000', 'USD'],
    ]),
  };
  if (o.unknownEntity)
    tables.recall_notes = csv([
      ['note_id', 'patient_id', 'text'],
      ['N001', 'P001', 'synthetic'],
    ]);
  if (o.exportSeq !== undefined) tables.export_info = csv([['export_seq'], [String(o.exportSeq)]]);
  return tables;
}

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const countRows = (t: string) => t.trim().split('\n').length - 1;

/** A package with a manifest computed from the tables (counts and digests honest unless overridden). */
export function legacyPackage(
  tables: Record<string, string>,
  extra: {
    sourceSystem?: string;
    practiceRef?: string;
    manifestOverride?: (e: ManifestRow[]) => ManifestRow[];
  } = {},
) {
  let entities: ManifestRow[] = Object.entries(tables).map(([name, text]) => ({
    name,
    declaredCount: countRows(text),
    artifactDigest: sha(text),
  }));
  if (extra.manifestOverride) entities = extra.manifestOverride(entities);
  return {
    format: 'cuspatlas-synthetic-legacy/1',
    sourceSystem: extra.sourceSystem ?? SOURCE_SYSTEM,
    practiceRef: extra.practiceRef ?? PRACTICE,
    producedAt: PRODUCED_AT,
    manifest: { entities },
    tables,
  };
}

export interface ManifestRow {
  name: string;
  declaredCount: number;
  artifactDigest: string;
}

export const intakeBody = (profileRef: string, pkg: unknown, practiceRef = PRACTICE) => ({
  profileRef,
  authorisation: { reference: 'syn-auth-alpha-2026', practiceRef },
  package: pkg,
});
