import { randomUUID } from 'node:crypto';
import { createTenantTransactionRunner } from '@cuspatlas/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, createPatient, mergePatients, T_ALPHA } from './support/appointment-fixtures';
import {
  addGuarantor,
  type BillingHarness,
  billingDigest,
  billingLeakSurface,
  openBillingHarness,
  postCharge,
  usd,
} from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, USER_A1 } from './support/fixtures';
import { MARKER } from './support/marker';

/**
 * B4: statement generation as an audited snapshot with derived staleness (synthetic data only;
 * every rule recommended-pending-billing-approval, ADR 0008). Generation and delivery are separate:
 * B4 generates and records; delivery belongs to E7 and is left with channel `none`.
 */
let db: TestDatabase;
let h: BillingHarness;

const ST = '/v1/billing/statements';
type Generated = {
  data: {
    statementRef: string;
    statementVersion: number;
    snapshotDigest: string;
    supersedesStatementRef: string | null;
  };
  version: number;
  replayed: boolean;
};
type Statement = Record<string, unknown> & {
  snapshotDigest: string;
  total: unknown;
  supersededByStatementRef: string | null;
  accounts: {
    accountPatientRef: string;
    coveredPatientRefs: string[];
    total: unknown;
    lines: Record<string, unknown>[];
  }[];
  freshness: { state: string; reasons: string[]; currentTotal: unknown; postedAfterCutoff: number };
};
const reason = (res: { statusCode: number; json: () => { code?: string; detail?: { reason?: string } } }) => [
  res.statusCode,
  res.json().code,
  res.json().detail?.reason,
];
/**
 * "Now" from the database clock that stamps `posted_at`. The host clock can lag it (the hosted
 * Windows runner's does), and a cutoff taken from it would exclude a posting made a moment ago.
 */
const now = async () =>
  (
    (await db.admin.query<{ at: Date }>(`SELECT clock_timestamp() AS at`)).rows[0] as { at: Date }
  ).at.toISOString();
const generate = async (guarantorRef: string, cutoffAt?: string, key: string = randomUUID(), who = 'a1') =>
  h.call(
    who,
    'POST',
    ST,
    { guarantorRef, cutoffAt: cutoffAt ?? (await now()), basis: 'posted_through_cutoff' },
    key,
  );
const read = async (statementRef: string, who = 'a1') =>
  h.ok<{ data: Statement }>(await h.call(who, 'GET', `${ST}/${statementRef}`)).data;
async function cash(patientRef: string, minor: number): Promise<string> {
  return h.ok<{ data: { paymentRef: string; entryRef: string } }>(
    await h.call('a1', 'POST', '/v1/billing/payments', { patientRef, amount: usd(minor), method: 'cash' }),
    201,
  ).data.paymentRef;
}

beforeAll(async () => {
  db = await openTestDatabase('billing_statements');
  h = await openBillingHarness(db, { pool: 10, mcp: true });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('B4 generation as an audited snapshot', () => {
  it("1. a guarantor statement groups its own and its dependents' accounts from the journal at the cutoff", async () => {
    const guarantor = await createPatient(h, 'Synthetic Statement Guarantor');
    const child = await createPatient(h, 'Synthetic Statement Child');
    await addGuarantor(h, child, guarantor);
    const own = await postCharge(h, guarantor, 3000);
    const kid = await postCharge(h, child, 5000);
    await cash(child, 1000);
    const g = h.ok<Generated>(await generate(guarantor), 201);
    expect(g.data).toMatchObject({ statementVersion: 1, supersedesStatementRef: null });
    expect(g.data.snapshotDigest).toMatch(/^[0-9a-f]{64}$/);
    const s = await read(g.data.statementRef);
    expect(s).toMatchObject({
      statementRef: g.data.statementRef,
      guarantorRef: guarantor,
      statementVersion: 1,
      basis: 'posted_through_cutoff',
      currency: 'USD',
      total: usd(7000),
      amountDue: usd(7000),
      creditBalance: usd(0),
      totalClass: 'due',
      snapshotDigest: g.data.snapshotDigest,
      integrity: 'verified',
      supersedesStatementRef: null,
      supersededByStatementRef: null,
      delivery: { channel: 'none', state: 'not_requested', owner: 'E7' },
      freshness: { state: 'fresh', reasons: [], currentTotal: usd(7000), postedAfterCutoff: 0 },
    });
    const byAccount = Object.fromEntries(s.accounts.map((a) => [a.accountPatientRef, a]));
    expect(byAccount[guarantor]?.total).toStrictEqual(usd(3000));
    expect(byAccount[child]?.total).toStrictEqual(usd(4000));
    expect(byAccount[child]?.lines.map((l) => [l.kind, l.amount])).toStrictEqual([
      ['charge', usd(5000)],
      ['patientPayment', usd(-1000)],
    ]);
    expect(byAccount[guarantor]?.lines[0]).toMatchObject({
      entryRef: own.entryRef,
      chargeRef: own.chargeRef,
    });
    expect(byAccount[child]?.lines[0]).toMatchObject({ chargeRef: kid.chargeRef });
    const audit = await db.admin.query(
      'SELECT operation, resource_type, resource_version FROM cuspatlas.audit_events WHERE resource_ref = $1',
      [g.data.statementRef],
    );
    expect(audit.rows).toStrictEqual([
      { operation: 'billing.statements.generate', resource_type: 'billingStatement', resource_version: 1 },
    ]);
  });

  it('2. the same key replays the same record; a new cutoff or a reissue is a new version that supersedes', async () => {
    const guarantor = await createPatient(h, 'Synthetic Statement Versions');
    await postCharge(h, guarantor, 1200);
    const key = randomUUID();
    const cutoff = await now();
    const first = h.ok<Generated>(await generate(guarantor, cutoff, key), 201);
    const replay = h.ok<Generated>(await generate(guarantor, cutoff, key), 201);
    expect([replay.replayed, replay.data]).toStrictEqual([true, first.data]);
    const second = h.ok<Generated>(await generate(guarantor), 201);
    expect(second.data).toMatchObject({
      statementVersion: 2,
      supersedesStatementRef: first.data.statementRef,
    });
    const reissue = h.ok<Generated>(await generate(guarantor, cutoff), 201);
    expect(reissue.data).toMatchObject({
      statementVersion: 3,
      supersedesStatementRef: second.data.statementRef,
    });
    const old = await read(first.data.statementRef);
    expect(old).toMatchObject({
      snapshotDigest: first.data.snapshotDigest,
      supersededByStatementRef: second.data.statementRef,
      total: usd(1200),
      freshness: { state: 'stale', reasons: ['superseded'] },
    });
    // Three concurrent generations for one guarantor serialize into a linear chain.
    const race = await Promise.all([1, 2, 3].map(() => generate(guarantor)));
    expect(race.map((r) => r.statusCode)).toStrictEqual([201, 201, 201]);
    const versions = race.map((r) => r.json().data.statementVersion).sort();
    expect(versions).toStrictEqual([4, 5, 6]);
  });
});

describe('B4 staleness is derived, the snapshot never restated', () => {
  it('3. a payment or reversal posted after generation makes the statement stale without touching it', async () => {
    const guarantor = await createPatient(h, 'Synthetic Statement Stale');
    await postCharge(h, guarantor, 4000);
    const g = h.ok<Generated>(await generate(guarantor), 201);
    const before = await db.admin.query(
      'SELECT to_jsonb(s) AS row FROM cuspatlas.billing_statements s WHERE id = $1',
      [g.data.statementRef],
    );
    const p = await cash(guarantor, 1500);
    let s = await read(g.data.statementRef);
    expect(s).toMatchObject({
      total: usd(4000),
      snapshotDigest: g.data.snapshotDigest,
      integrity: 'verified',
      freshness: {
        state: 'stale',
        reasons: ['posted_after_cutoff'],
        currentTotal: usd(2500),
        postedAfterCutoff: 1,
      },
    });
    const pay = h.ok<{ data: { entryRef: string } }>(
      await h.call('a1', 'GET', `/v1/billing/payments/${p}`),
    ).data;
    h.ok(
      await h.call('a1', 'POST', `/v1/billing/entries/${pay.entryRef}/reverse`, {
        reasonCode: 'posted_in_error',
      }),
      201,
    );
    s = await read(g.data.statementRef);
    // The reversal brings the current total back, but the postings after the cutoff still stand.
    expect(s.freshness).toMatchObject({ state: 'stale', currentTotal: usd(4000), postedAfterCutoff: 2 });
    const after = await db.admin.query(
      'SELECT to_jsonb(s) AS row FROM cuspatlas.billing_statements s WHERE id = $1',
      [g.data.statementRef],
    );
    expect(after.rows).toStrictEqual(before.rows);
  });

  it('4. a cutoff before a posting excludes it from the snapshot and the statement is stale at once', async () => {
    const guarantor = await createPatient(h, 'Synthetic Statement Cutoff');
    await postCharge(h, guarantor, 1000);
    const cutoff = await now();
    await new Promise((r) => setTimeout(r, 5));
    await postCharge(h, guarantor, 700);
    const s = await read(h.ok<Generated>(await generate(guarantor, cutoff), 201).data.statementRef);
    expect(s).toMatchObject({
      cutoffAt: cutoff,
      total: usd(1000),
      freshness: { state: 'stale', reasons: ['posted_after_cutoff'], currentTotal: usd(1700) },
    });
    expect(s.accounts[0]?.lines).toHaveLength(1);
  });

  it('5. credit and zero balances follow an explicit rule, never a silent negative statement', async () => {
    const credit = await createPatient(h, 'Synthetic Statement Credit');
    await postCharge(h, credit, 500);
    await cash(credit, 800);
    expect(await read(h.ok<Generated>(await generate(credit), 201).data.statementRef)).toMatchObject({
      total: usd(-300),
      totalClass: 'credit',
      amountDue: usd(0),
      creditBalance: usd(300),
    });
    const zero = await createPatient(h, 'Synthetic Statement Zero');
    expect(await read(h.ok<Generated>(await generate(zero), 201).data.statementRef)).toMatchObject({
      total: usd(0),
      totalClass: 'zero',
      amountDue: usd(0),
      creditBalance: usd(0),
    });
  });

  it("6. a merged pair is one account on the survivor's statement", async () => {
    const survivor = await createPatient(h, 'Synthetic Statement Merge');
    const merged = await createPatient(h, 'Synthetic Statement Merge');
    await postCharge(h, survivor, 100);
    await postCharge(h, merged, 200);
    await mergePatients(h, survivor, merged);
    const s = await read(h.ok<Generated>(await generate(survivor), 201).data.statementRef);
    expect(s.accounts).toHaveLength(1);
    expect(s.accounts[0]).toMatchObject({ accountPatientRef: survivor, total: usd(300) });
    expect([...(s.accounts[0]?.coveredPatientRefs ?? [])].sort()).toStrictEqual([survivor, merged].sort());
    expect(reason(await generate(merged))).toStrictEqual([409, 'conflict', 'patient_merged']);
  });
});

describe('B4 refusals, isolation, parity and storage', () => {
  it('7. refusals are typed, another tenant is hidden, and a refusal writes nothing', async () => {
    const guarantor = await createPatient(h, 'Synthetic Statement Refusals');
    const dependent = await createPatient(h, 'Synthetic Statement Dependent');
    await addGuarantor(h, guarantor, dependent);
    const before = await billingDigest(db);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(reason(await generate(guarantor, future))).toStrictEqual([
      422,
      'validation_failed',
      'cutoff_in_future',
    ]);
    // Someone else guarantees this patient and it guarantees no one: there is no account to state.
    expect(reason(await generate(guarantor))).toStrictEqual([
      422,
      'validation_failed',
      'guarantor_unresolved',
    ]);
    const beta = await createPatient(h, 'Synthetic Statement Beta', 'b1');
    const hidden = await generate(beta);
    const missing = await generate(randomUUID());
    expect([hidden.statusCode, hidden.json().code]).toStrictEqual([404, 'not_found']);
    expect(hidden.json().detail).toStrictEqual(missing.json().detail);
    for (const body of [
      { guarantorRef: guarantor, cutoffAt: await now(), basis: 'current_balance' },
      { guarantorRef: guarantor, cutoffAt: MARKER, basis: 'posted_through_cutoff' },
      { guarantorRef: MARKER, cutoffAt: await now(), basis: 'posted_through_cutoff' },
      { guarantorRef: guarantor, cutoffAt: await now(), basis: 'posted_through_cutoff', tenantId: T_ALPHA },
    ]) {
      const r = await h.call('a1', 'POST', ST, body);
      expect(r.statusCode).toBe(400);
      expect(r.body).not.toContain(MARKER);
    }
    expect(await billingDigest(db)).toBe(before);
    const own = await createPatient(h, 'Synthetic Statement Owned');
    const g = h.ok<Generated>(await generate(own), 201);
    const hiddenRead = await h.call('b1', 'GET', `${ST}/${g.data.statementRef}`);
    const missingRead = await h.call('a1', 'GET', `${ST}/${randomUUID()}`);
    expect([hiddenRead.statusCode, hiddenRead.json().detail]).toStrictEqual([404, missingRead.json().detail]);
    expect((await h.call(h.a5, 'GET', `${ST}/${g.data.statementRef}`)).statusCode).toBe(403);
    expect(
      (
        await h.call('a4', 'POST', ST, {
          guarantorRef: own,
          cutoffAt: await now(),
          basis: 'posted_through_cutoff',
        })
      ).statusCode,
    ).toBe(403);
    expect((await h.call('a4', 'GET', `${ST}/${g.data.statementRef}`)).statusCode).toBe(200);
  });

  it('8. a failure inside generation leaves no statement, audit or outbox row', async () => {
    const guarantor = await createPatient(h, 'Synthetic Statement Fault');
    await postCharge(h, guarantor, 100);
    const counts = async () =>
      [
        await count(db, 'billing_statements'),
        await count(db, 'audit_events'),
        await count(db, 'outbox_events'),
      ].join(',');
    const before = await counts();
    await db.admin.query('REVOKE INSERT ON cuspatlas.outbox_events FROM cuspatlas_app');
    try {
      expect((await generate(guarantor)).statusCode).toBe(500);
    } finally {
      await db.admin.query('GRANT INSERT ON cuspatlas.outbox_events TO cuspatlas_app');
    }
    expect(await counts()).toBe(before);
  });

  it('9. MCP gives the same outcomes; statement content never reaches a log', async () => {
    const guarantor = await createPatient(h, 'Synthetic Statement Mcp');
    const c = await postCharge(h, guarantor, 900);
    const g = await h.mcp(
      'a1',
      'billing_statements_generate',
      {
        guarantorRef: guarantor,
        cutoffAt: await now(),
        basis: 'posted_through_cutoff',
        idempotencyKey: randomUUID(),
      },
      201,
    );
    const ref = (g.body.data as { statementRef: string }).statementRef;
    const viaMcp = await h.mcp('a4', 'billing_statements_get', { statementRef: ref });
    const viaRest = await read(ref, 'a4');
    expect((viaMcp.body.data as Statement).snapshotDigest).toBe(viaRest.snapshotDigest);
    const hidden = await h.mcp('b1', 'billing_statements_get', { statementRef: ref });
    expect([hidden.status, hidden.code]).toStrictEqual([404, 'not_found']);
    const future = await h.mcp('a1', 'billing_statements_generate', {
      guarantorRef: guarantor,
      cutoffAt: new Date(Date.now() + 3_600_000).toISOString(),
      basis: 'posted_through_cutoff',
      idempotencyKey: randomUUID(),
    });
    expect([future.status, (future.body.detail as { reason: string }).reason]).toStrictEqual([
      422,
      'cutoff_in_future',
    ]);
    const logs = h.logLines.join('\n');
    for (const secret of [viaRest.snapshotDigest, c.entryRef, MARKER]) expect(logs).not.toContain(secret);
    expect(await billingLeakSurface(db)).not.toContain(MARKER);
  });

  it('10. a generated statement row is never updated or deleted under the runtime role', async () => {
    const guarantor = await createPatient(h, 'Synthetic Statement Immutable');
    const g = h.ok<Generated>(await generate(guarantor), 201);
    const tx = createTenantTransactionRunner(db.app);
    const ctx = ctxFor(T_ALPHA, USER_A1, 'human');
    const before = await billingDigest(db);
    for (const sql of [
      `UPDATE cuspatlas.billing_statements SET snapshot_total_minor = 1 WHERE id = '${g.data.statementRef}'`,
      `UPDATE cuspatlas.billing_statements SET delivery_channel = 'none' WHERE id = '${g.data.statementRef}'`,
      `DELETE FROM cuspatlas.billing_statements WHERE id = '${g.data.statementRef}'`,
    ]) {
      await expect(tx(ctx, (t) => t.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
    expect(await billingDigest(db)).toBe(before);
    const { rows } = await db.admin.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'cuspatlas'
         AND table_name = 'billing_statements' AND column_name ~ '(stale|fresh)'`,
    );
    expect(rows).toStrictEqual([]);
  });
});
