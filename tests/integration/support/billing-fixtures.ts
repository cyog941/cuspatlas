import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { type AppointmentHarness, openAppointmentHarness } from './appointment-fixtures';
import type { TestDatabase } from './db';
import { SVC_A1, SVC_B1, T_ALPHA, USER_A1, USER_A2, USER_A3, USER_A4, USER_B1 } from './fixtures';
import { USER_A5 } from './patient-fixtures';

/**
 * Billing scopes layered on top of the patient and scheduling fixtures (superuser fixture path,
 * test-only). a1 everything; a2 the same but REVOKED; a3 posting and reads; a4 the report reads only
 * (downgraded role); a5 no billing scope; svc-a1 posting and reads but never corrections (a
 * service principal cannot hold a human-only correction anyway); b1 and svc-b1 in tenant beta.
 */
export const BILLING_READS = [
  'ledger.read',
  'paymentDistribution.read',
  'undistributedFunds.read',
  'receivables.read',
];
export const BILLING_WRITE = 'billing.write';
export const BILLING_CORRECT = 'billing.correct';
export const BILLING_ALL = [...BILLING_READS, BILLING_WRITE, BILLING_CORRECT];

export async function seedBillingScopes(admin: pg.Pool): Promise<void> {
  const add: [string, string[]][] = [
    [USER_A1, BILLING_ALL],
    [USER_A2, BILLING_ALL],
    [USER_A3, [...BILLING_READS, BILLING_WRITE]],
    [USER_A4, BILLING_READS],
    [SVC_A1, [...BILLING_READS, BILLING_WRITE, BILLING_CORRECT]],
    [USER_B1, BILLING_ALL],
    [SVC_B1, [...BILLING_READS, BILLING_WRITE]],
  ];
  for (const [principal, scopes] of add) {
    await admin.query(
      'UPDATE cuspatlas.memberships SET scopes = scopes || $2::text[] WHERE principal_id = $1',
      [principal, scopes],
    );
  }
}

export interface BillingHarness extends AppointmentHarness {
  /** Token of a5 (tenant alpha member without any billing scope). */
  readonly a5: string;
}

export async function openBillingHarness(
  db: TestDatabase,
  opts: { pool?: number; mcp?: boolean } = {},
): Promise<BillingHarness> {
  const h = await openAppointmentHarness(db, opts);
  await seedBillingScopes(db.admin);
  const a5 = await h.issuer.issue({ sub: USER_A5, tid: T_ALPHA });
  return Object.assign(h, { a5 });
}

export const usd = (minor: number) => ({ currency: 'USD', minor });

let procedureSeq = 0;
/** A fresh synthetic procedure reference (the C14 seam). */
export const procedureRef = () => {
  procedureSeq += 1;
  return `syn-proc-${Date.now().toString(36)}-${procedureSeq}`;
};

export async function postCharge(
  h: AppointmentHarness,
  patientRef: string,
  minor: number,
  extra: Record<string, unknown> = {},
  who = 'a1',
): Promise<{ chargeRef: string; entryRef: string }> {
  const r = h.ok<{ data: { chargeRef: string; entryRef: string } }>(
    await h.call(
      who,
      'POST',
      '/v1/billing/charges',
      { patientRef, procedureRef: procedureRef(), serviceDate: '2026-10-01', amount: usd(minor), ...extra },
      randomUUID(),
    ),
    201,
  );
  return r.data;
}

/** Records an S5 guarantor relationship (financial scope) from `patientRef` to `guarantorRef`. */
export async function addGuarantor(
  h: AppointmentHarness,
  patientRef: string,
  guarantorRef: string,
): Promise<void> {
  h.ok(
    await h.call('a1', 'POST', `/v1/patients/${patientRef}/relationships`, {
      counterpartyRef: guarantorRef,
      kind: 'guarantor',
      scopes: ['financial'],
    }),
    201,
  );
}

export async function balanceOf(
  h: AppointmentHarness,
  patientRef: string,
  query = '',
): Promise<Record<string, unknown> & { balance: { minor: number } }> {
  const r = h.ok<{ data: Record<string, unknown> & { balance: { minor: number } } }>(
    await h.call('a1', 'GET', `/v1/billing/patients/${patientRef}/balance${query}`),
  );
  return r.data;
}

/** Digest of every billing row (superuser read), to prove an operation changed no posted fact. */
export async function billingDigest(db: TestDatabase): Promise<string> {
  const parts: string[] = [];
  for (const t of await billingTables(db)) {
    const { rows } = await db.admin.query(
      `SELECT coalesce(md5(string_agg(to_jsonb(t)::text, '|' ORDER BY t.id)), '') AS d FROM cuspatlas.${t} t`,
    );
    parts.push(`${t}:${rows[0].d}`);
  }
  return parts.join(',');
}

export async function billingTables(db: TestDatabase): Promise<string[]> {
  const { rows } = await db.admin.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'cuspatlas' AND c.relkind = 'r' AND c.relname LIKE 'billing\\_%' AND c.relname <> 'billing_settings'
     ORDER BY 1`,
  );
  return rows.map((r) => r.relname);
}

/** Every table text a caller-controlled value could leak into, including the billing tables. */
export async function billingLeakSurface(db: TestDatabase): Promise<string> {
  const parts: string[] = [];
  for (const t of [
    'audit_events',
    'outbox_events',
    'security_attempt_events',
    'command_idempotency',
    'sensitive_read_events',
    ...(await billingTables(db)),
  ]) {
    const { rows } = await db.admin.query(
      `SELECT coalesce(json_agg(t)::text, '') AS j FROM cuspatlas.${t} t`,
    );
    parts.push(rows[0].j);
  }
  return parts.join('\n');
}
