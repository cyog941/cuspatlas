import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppointmentHarness, count, openAppointmentHarness } from './support/appointment-fixtures';
import { seedBillingScopes } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { T_ALPHA, USER_A1 } from './support/fixtures';
import {
  intakeBody,
  legacyPackage,
  legacyTables,
  PRACTICE,
  SOURCE_SYSTEM,
  seedMigrationScopes,
} from './support/migration-fixtures';

/**
 * M5: opening balances as `openingBalance` journal entries on dedicated opening accounts, unapplied
 * credit per source payment with its age basis, open claims as references only, and per-guarantor
 * reconciliation. Money is integer minor units. Synthetic only; financial sign-off pending.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let profileRef: string;
let packageRef: string;

type Money = { currency: string; minor: number };
interface Opening {
  items: {
    kind: string;
    sourceRef: string;
    amount: Money;
    asOf: string | null;
    asOfPrecision: string;
    ageBasis: string | null;
    claimState: string | null;
    entryRef: string | null;
  }[];
  byGuarantor: {
    guarantorSourceId: string;
    sourceBalance: Money;
    importedBalance: Money;
    balanceDifference: Money;
    sourceCredit: Money;
    importedCredit: Money;
  }[];
  totals: { difference: Money };
}
const usd = (minor: number) => ({ currency: 'USD', minor });
const items = async (pkg: string) =>
  h.ok<{
    data: { itemRef: string; category: string; field: string | null; proposal: Record<string, unknown> }[];
  }>(await h.call('a1', 'GET', `/v1/migration/review-items?packageRef=${pkg}&state=open`)).data;
const resolve = (pkg: string, itemRef: string, decision: string) =>
  h.call('a1', 'POST', '/v1/migration/review-items/resolve', {
    packageRef: pkg,
    itemRef,
    decision,
    reasonCode: 'finance_reviewed',
  });
const plan = async (pkg: string) =>
  h.ok<{ data: { planDigest: string; exceptions: { code: string; entity: string }[] } }>(
    await h.call('a1', 'GET', `/v1/migration/imports/plan?packageRef=${pkg}`),
  ).data;
const applyAll = async (pkg: string) =>
  h.ok(
    await h.call('a1', 'POST', '/v1/migration/imports/apply', {
      packageRef: pkg,
      expectedPlanDigest: (await plan(pkg)).planDigest,
      batchSize: 200,
    }),
  );
const opening = async (pkg: string, who = 'a1') =>
  h.ok<{ data: Opening }>(await h.call(who, 'GET', `/v1/migration/opening-items?packageRef=${pkg}`)).data;
const stage = async (tables: Record<string, string>) =>
  h.ok<{ data: { packageRef: string } }>(
    await h.call('a1', 'POST', '/v1/migration/packages', intakeBody(profileRef, legacyPackage(tables))),
    201,
  ).data.packageRef;
const claimTables = async () =>
  (
    await db.admin.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'cuspatlas' AND c.relkind = 'r' AND (c.relname LIKE 'rcm\\_claim%' OR c.relname LIKE 'billing\\_%')
         AND c.relname NOT LIKE 'billing\\_journal%' ORDER BY 1`,
    )
  ).rows.map((r) => r.relname as string);
const snapshot = async () =>
  Object.fromEntries(await Promise.all((await claimTables()).map(async (t) => [t, await count(db, t)])));

beforeAll(async () => {
  db = await openTestDatabase('migration_opening');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedBillingScopes(db.admin);
  await seedMigrationScopes(db.admin);
  profileRef = h.ok<{ data: { profileRef: string } }>(
    await h.call('a1', 'POST', '/v1/migration/source-profiles', {
      sourceSystem: SOURCE_SYSTEM,
      format: 'cuspatlas-synthetic-legacy/1',
      practiceRef: PRACTICE,
    }),
    201,
  ).data.profileRef;
  packageRef = await stage(legacyTables({ negativeBalance: true }));
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('M5 opening facts', () => {
  it('an ambiguous negative balance waits for staff; a currency problem cannot be accepted as proposed', async () => {
    const p = await plan(packageRef);
    expect(p.exceptions.filter((e) => e.entity === 'ledger_balances').map((e) => e.code)).toStrictEqual([
      'review_open',
    ]);
    const eur = await stage({
      ledger_balances:
        'balance_id,account_id,patient_id,balance_minor,currency,as_of\nE001,G1,P001,500,EUR,2026-10-31\n',
    });
    const cur = (await items(eur)).find((i) => i.category === 'monetary_semantics');
    const r = await resolve(eur, cur?.itemRef as string, 'acceptProposal');
    expect([r.statusCode, r.json().detail?.reason]).toStrictEqual([422, 'no_proposal']);
  });

  it('records opening balances, unapplied credit and open claims without any charge, payment or claim', async () => {
    for (const i of await items(packageRef)) {
      if (i.category === 'terminology') h.ok(await resolve(packageRef, i.itemRef, 'archiveOnly'));
      if (i.category === 'monetary_semantics') h.ok(await resolve(packageRef, i.itemRef, 'acceptProposal'));
    }
    const before = await snapshot();
    const entriesBefore = await count(db, 'billing_journal_entries');
    await applyAll(packageRef);
    expect(await snapshot()).toStrictEqual(before);
    expect(await count(db, 'billing_journal_entries')).toBe(entriesBefore + 5);
    const { rows } = await db.admin.query(
      `SELECT DISTINCT e.kind, l.account FROM cuspatlas.billing_journal_entries e
       JOIN cuspatlas.billing_journal_lines l ON l.entry_id = e.id ORDER BY 1, 2`,
    );
    expect(rows).toStrictEqual([
      { kind: 'openingBalance', account: 'opening_credit' },
      { kind: 'openingBalance', account: 'opening_equity' },
      { kind: 'openingBalance', account: 'opening_receivable' },
    ]);
    const o = await opening(packageRef, 'a4');
    const by = (ref: string) => o.items.find((i) => i.sourceRef === ref);
    expect(by('B001')).toMatchObject({
      kind: 'balance',
      amount: usd(12500),
      asOf: '2026-10-31',
      asOfPrecision: 'day',
    });
    // No reliable as-of date in the source: approximate, never a fabricated date.
    expect(by('B002')).toMatchObject({
      kind: 'balance',
      amount: usd(4000),
      asOf: null,
      asOfPrecision: 'approximate',
    });
    expect(by('B004')).toMatchObject({ kind: 'unappliedCredit', amount: usd(1500) });
    expect(by('C001')).toMatchObject({ kind: 'unappliedCredit', amount: usd(2000), ageBasis: '2026-09-15' });
    expect(by('K001')).toMatchObject({
      kind: 'openClaim',
      amount: usd(18000),
      claimState: 'submitted',
      entryRef: null,
    });
    expect(o.byGuarantor).toStrictEqual([
      {
        guarantorSourceId: 'G1',
        sourceBalance: usd(16500),
        importedBalance: usd(16500),
        balanceDifference: usd(0),
        sourceCredit: usd(2000),
        importedCredit: usd(2000),
        creditDifference: usd(0),
      },
      {
        guarantorSourceId: 'G2',
        sourceBalance: usd(7700),
        importedBalance: usd(7700),
        balanceDifference: usd(0),
        sourceCredit: usd(1500),
        importedCredit: usd(1500),
        creditDifference: usd(0),
      },
    ]);
    expect(o.totals.difference).toStrictEqual(usd(0));
    expect(
      (await h.call('b1', 'GET', `/v1/migration/opening-items?packageRef=${packageRef}`)).statusCode,
    ).toBe(404);
    expect(
      (await h.call('a5', 'GET', `/v1/migration/opening-items?packageRef=${packageRef}`)).statusCode,
    ).toBe(403);
  });

  it('an opening entry cannot be reversed as a ledger entry, reposted, or moved to a charge or payment account', async () => {
    const o = await opening(packageRef);
    const entryRef = o.items.find((i) => i.kind === 'balance')?.entryRef as string;
    const rev = await h.call('a1', 'POST', `/v1/billing/entries/${entryRef}/reverse`, {
      reasonCode: 'posted_in_error',
    });
    expect([rev.statusCode, rev.json().detail?.reason]).toStrictEqual([
      409,
      'opening_balance_correction_via_migration',
    ]);
    const { rows } = await db.admin.query(
      `SELECT l.opening_item_id, l.patient_id, l.amount_minor::text AS a FROM cuspatlas.billing_journal_lines l
       WHERE l.entry_id = $1 AND l.account = 'opening_receivable'`,
      [entryRef],
    );
    const line = rows[0];
    const attempt = async (accounts: [string, string], item: string | null) => {
      const c = await db.admin.connect();
      try {
        await c.query('BEGIN');
        const e = await c.query(
          `INSERT INTO cuspatlas.billing_journal_entries (tenant_id, kind, currency, line_count, posted_by, correlation_id)
           VALUES ($1, 'openingBalance', 'USD', 2, $2, gen_random_uuid()) RETURNING id`,
          [T_ALPHA, USER_A1],
        );
        await c.query(
          `INSERT INTO cuspatlas.billing_journal_lines (tenant_id, entry_id, line_no, account, amount_minor, currency, patient_id,
             opening_item_id, payment_id)
           VALUES ($1, $2, 1, $3, $5::bigint, 'USD', $6, $7, NULL), ($1, $2, 2, $4, -$5::bigint, 'USD', $6, $7, NULL)`,
          [T_ALPHA, e.rows[0].id, accounts[0], accounts[1], line.a, line.patient_id, item],
        );
        await c.query('COMMIT');
        return 'committed';
      } catch (err) {
        await c.query('ROLLBACK');
        return (err as { code?: string }).code ?? 'error';
      } finally {
        c.release();
      }
    };
    // The same opening item twice, and an opening kind on a payment account: both refused.
    expect(await attempt(['opening_receivable', 'opening_equity'], line.opening_item_id)).toBe('23514');
    expect(await attempt(['unapplied_credit', 'opening_equity'], line.opening_item_id)).toBe('23514');
  });

  it('a duplicate opening balance for one patient, currency and date is excluded, never posted twice', async () => {
    const dup = await stage({
      patients:
        'patient_id,last_name,first_name,birth_date,phone,guarantor_id\nD001,Dupe,Rowan,1970-07-07,5550400001,G7\n',
      ledger_balances:
        'balance_id,account_id,patient_id,balance_minor,currency,as_of\nD101,G7,D001,1000,USD,2026-10-31\nD102,G7,D001,1000,USD,2026-10-31\n',
    });
    expect((await plan(dup)).exceptions.map((e) => e.code)).toStrictEqual(['duplicate_opening']);
    await applyAll(dup);
    const o = await opening(dup);
    expect(o.items.map((i) => i.sourceRef)).toStrictEqual(['D101']);
    // The source total is still stated, so the difference is explicit rather than hidden.
    expect(o.byGuarantor[0]).toMatchObject({
      sourceBalance: usd(2000),
      importedBalance: usd(1000),
      balanceDifference: usd(1000),
    });
  });
});
