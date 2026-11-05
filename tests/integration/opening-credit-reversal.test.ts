import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppointmentHarness, openAppointmentHarness } from './support/appointment-fixtures';
import { postCharge, seedBillingScopes } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import {
  intakeBody,
  legacyPackage,
  PRACTICE,
  SOURCE_SYSTEM,
  seedMigrationScopes,
} from './support/migration-fixtures';

/**
 * Closeout A7 (H2 M-10 open item): an allocation of migrated opening credit is reversed through B's one
 * correction path, `billing.entries.reverse`, never a bypass. The reversal is a new compensating entry
 * (the allocation stays posted), applies once, returns the amount to the opening credit item, which can
 * then be allocated again up to what it holds. Synthetic only.
 */
let db: TestDatabase;
let h: AppointmentHarness;
let patient: string;
let credit: string;
let chargeA: string;
let chargeB: string;
let allocation: string;
let reversal: string;

type Balance = { patientResponsibility: { minor: number }; unappliedCredit: { minor: number } };
type Line = { account: string; amount: { currency: string; minor: number } };
type Entry = {
  entryRef: string;
  kind: string;
  reversesEntryRef: string | null;
  reversedByEntryRef: string | null;
  reasonCode: string | null;
  lines: Line[];
};
const balance = async () =>
  h.ok<{ data: Balance }>(await h.call('a1', 'GET', `/v1/billing/patients/${patient}/balance`)).data;
const allocate = (chargeRef: string, minor: number) =>
  h.call(
    'a1',
    'POST',
    `/v1/billing/payments/${credit}/allocations`,
    { allocations: [{ chargeRef, amount: { currency: 'USD', minor } }] },
    randomUUID(),
  );
const reverse = (
  who: string,
  entryRef: string,
  body: Record<string, unknown> = { reasonCode: 'posting_error' },
) => h.call(who, 'POST', `/v1/billing/entries/${entryRef}/reverse`, body, randomUUID());
const reason = (r: { statusCode: number; json(): { code?: string; detail?: { reason?: string } } }) => [
  r.statusCode,
  r.json().detail?.reason ?? r.json().code,
];
const journalCount = async () =>
  Number((await db.admin.query('SELECT count(*) FROM cuspatlas.billing_journal_entries')).rows[0].count);

beforeAll(async () => {
  db = await openTestDatabase('opening_credit_reversal');
  h = await openAppointmentHarness(db);
  await seedBillingScopes(db.admin);
  await seedMigrationScopes(db.admin);
  const profileRef = h.ok<{ data: { profileRef: string } }>(
    await h.call('a1', 'POST', '/v1/migration/source-profiles', {
      sourceSystem: SOURCE_SYSTEM,
      format: 'cuspatlas-synthetic-legacy/1',
      practiceRef: PRACTICE,
    }),
    201,
  ).data.profileRef;
  const pkg = h.ok<{ data: { packageRef: string } }>(
    await h.call(
      'a1',
      'POST',
      '/v1/migration/packages',
      intakeBody(
        profileRef,
        legacyPackage({
          patients:
            'patient_id,last_name,first_name,birth_date,phone,guarantor_id\nV001,Reverse,Vale,1988-08-08,5553300001,G1\n',
          unapplied_credits:
            'payment_id,account_id,patient_id,amount_minor,currency,received_on\nVC1,G1,V001,1000,USD,2026-09-01\n',
        }),
      ),
    ),
    201,
  ).data.packageRef;
  const plan = h.ok<{ data: { planDigest: string } }>(
    await h.call('a1', 'GET', `/v1/migration/imports/plan?packageRef=${pkg}`),
  ).data;
  h.ok(
    await h.call('a1', 'POST', '/v1/migration/imports/apply', {
      packageRef: pkg,
      expectedPlanDigest: plan.planDigest,
      batchSize: 200,
    }),
  );
  const { rows } = await db.admin.query(
    `SELECT id, patient_id FROM cuspatlas.migration_opening_items WHERE package_id = $1 AND kind = 'unappliedCredit'`,
    [pkg],
  );
  credit = rows[0]?.id as string;
  patient = rows[0]?.patient_id as string;
  chargeA = (await postCharge(h, patient, 700)).chargeRef;
  chargeB = (await postCharge(h, patient, 500)).chargeRef;
  allocation = (
    h.ok<{ data: { allocationRefs: string[] } }>(await allocate(chargeA, 600), 201).data
      .allocationRefs as string[]
  )[0] as string;
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('A7 reversing an opening-credit allocation', () => {
  it('is refused for another tenant, a role without billing.correct, a service principal and a revoked member', async () => {
    const before = await journalCount();
    expect((await reverse('b1', allocation)).statusCode).toBe(404);
    for (const who of ['a3', 'a4', 'svcA1', 'a2'])
      expect([who, (await reverse(who, allocation)).statusCode]).toStrictEqual([who, 403]);
    // A reason is required.
    expect((await reverse('a1', allocation, {})).statusCode).toBe(400);
    expect(await journalCount()).toBe(before);
    expect(await balance()).toMatchObject({ unappliedCredit: { minor: 400 } });
  });

  it('refuses a stale expected version, then reverses once and restores the opening credit', async () => {
    expect(
      reason(await reverse('a1', allocation, { reasonCode: 'posting_error', expectedVersion: 1 })),
    ).toStrictEqual([409, 'stale_version']);
    // The opening item's version counts its posted entries: the opening entry and the allocation.
    const r = h.ok<{ data: { entryRef: string; reversesEntryRef: string }; version: number }>(
      await reverse('a1', allocation, { reasonCode: 'posting_error', expectedVersion: 2 }),
      201,
    );
    expect([r.data.reversesEntryRef, r.version]).toStrictEqual([allocation, 3]);
    reversal = r.data.entryRef;
    expect(await balance()).toMatchObject({
      patientResponsibility: { minor: 1200 },
      unappliedCredit: { minor: 1000 },
    });
    expect(reason(await reverse('a1', allocation))).toStrictEqual([409, 'already_reversed']);
    expect(reason(await reverse('a1', reversal))).toStrictEqual([409, 'reversal_not_reversible']);
  });

  it('keeps the allocation posted and shows the compensating entry in the journal and the ledger', async () => {
    const entry = async (ref: string) =>
      h.ok<{ data: Entry }>(await h.call('a1', 'GET', `/v1/billing/entries/${ref}`)).data;
    const original = await entry(allocation);
    const comp = await entry(reversal);
    expect(original).toMatchObject({
      kind: 'allocation',
      reversesEntryRef: null,
      reversedByEntryRef: reversal,
    });
    expect(comp).toMatchObject({
      kind: 'allocation',
      reversesEntryRef: allocation,
      reasonCode: 'posting_error',
    });
    const amounts = (e: Entry) => e.lines.map((l) => [l.account, l.amount.minor]).sort();
    expect(amounts(original)).toStrictEqual([
      ['opening_credit', 600],
      ['patient_receivable', -600],
    ]);
    expect(amounts(comp)).toStrictEqual([
      ['opening_credit', -600],
      ['patient_receivable', 600],
    ]);
    // Both lines of the reversal draw on the same opening item as the original.
    const { rows } = await db.admin.query(
      `SELECT entry_id, opening_item_id FROM cuspatlas.billing_journal_lines
       WHERE entry_id = ANY ($1::uuid[]) AND account = 'opening_credit' ORDER BY entry_id`,
      [[allocation, reversal]],
    );
    expect(rows.map((x) => x.opening_item_id)).toStrictEqual([credit, credit]);
    const ledger = h.ok<{ data: Entry[] }>(
      await h.call('a1', 'GET', `/v1/billing/patients/${patient}/ledger`),
    ).data;
    expect(ledger.map((e) => e.entryRef)).toEqual(expect.arrayContaining([allocation, reversal]));
    const { rows: audit } = await db.admin.query(
      `SELECT resource_type, resource_ref, resource_version FROM cuspatlas.audit_events
       WHERE operation = 'billing.entries.reverse'`,
    );
    expect(audit).toStrictEqual([
      { resource_type: 'migrationOpeningItem', resource_ref: credit, resource_version: 3 },
    ]);
  });

  it('allocates the restored credit again, up to what the item holds', async () => {
    h.ok(await allocate(chargeA, 700), 201);
    expect(reason(await allocate(chargeB, 400))).toStrictEqual([409, 'insufficient_funds']);
    h.ok(await allocate(chargeB, 300), 201);
    expect(await balance()).toMatchObject({
      patientResponsibility: { minor: 200 },
      unappliedCredit: { minor: 0 },
    });
  });

  it('the database refuses a forged reversal that names no opening item', async () => {
    const c = await db.admin.connect();
    const attempt = async (lines: [string, number, string | null][]) => {
      try {
        await c.query('BEGIN');
        const { rows } = await c.query(
          `INSERT INTO cuspatlas.billing_journal_entries (tenant_id, kind, currency, line_count, charge_id,
             reverses_entry_id, reason_code, posted_by, correlation_id)
           SELECT tenant_id, 'allocation', 'USD', 2, charge_id, id, 'posting_error', posted_by, gen_random_uuid()
           FROM cuspatlas.billing_journal_entries WHERE id = $1 RETURNING id, tenant_id`,
          [forgeTarget],
        );
        for (const [i, [account, amount, item]] of lines.entries())
          await c.query(
            `INSERT INTO cuspatlas.billing_journal_lines (tenant_id, entry_id, line_no, account, amount_minor, currency,
               patient_id, charge_id, opening_item_id)
             VALUES ($1, $2, $3, $4, $5, 'USD', $6, $7, $8)`,
            [
              rows[0].tenant_id,
              rows[0].id,
              i + 1,
              account,
              amount,
              patient,
              account === 'opening_credit' ? null : chargeB,
              item,
            ],
          );
        await c.query('COMMIT');
        return 'accepted';
      } catch (err) {
        await c.query('ROLLBACK');
        return (err as { code?: string }).code;
      }
    };
    // The latest allocation (300 onto charge B) is the target of the forged reversals.
    const { rows } = await db.admin.query(
      `SELECT e.id FROM cuspatlas.billing_journal_entries e WHERE e.kind = 'allocation' AND e.charge_id = $1`,
      [chargeB],
    );
    const forgeTarget = rows[0]?.id as string;
    try {
      // Draws the reversal onto no opening item: refused.
      expect(
        await attempt([
          ['opening_credit', -300, null],
          ['patient_receivable', 300, null],
        ]),
      ).toBe('23514');
    } finally {
      c.release();
    }
  });
});
