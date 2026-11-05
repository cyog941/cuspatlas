import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTenantTransactionRunner } from '@cuspatlas/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, createPatient, mergePatients, T_ALPHA, T_BETA } from './support/appointment-fixtures';
import {
  type BillingHarness,
  balanceOf,
  billingDigest,
  billingLeakSurface,
  openBillingHarness,
  postCharge,
  procedureRef,
  usd,
} from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, USER_A1 } from './support/fixtures';
import { MARKER } from './support/marker';

/**
 * B1: Money and the append-only journal. Every call goes through REST (and MCP where stated) under
 * the runtime role; every database refusal is asserted with the runtime role `cuspatlas_app`.
 * Financial rules are recommended-pending-billing-approval (ADR 0008); synthetic data only.
 */
let db: TestDatabase;
let h: BillingHarness;

const CHARGES = '/v1/billing/charges';
const reverse = (entryRef: string, body: unknown = { reasonCode: 'posted_in_error' }, key = randomUUID()) =>
  h.call('a1', 'POST', `/v1/billing/entries/${entryRef}/reverse`, body, key);
const entry = async (entryRef: string) =>
  h.ok<{ data: Record<string, unknown> & { lines: { amount: { minor: number }; account: string }[] } }>(
    await h.call('a1', 'GET', `/v1/billing/entries/${entryRef}`),
  ).data;

beforeAll(async () => {
  db = await openTestDatabase('billing_journal');
  h = await openBillingHarness(db, { pool: 8, mcp: true });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('B1 charge posting and exact minor units', () => {
  it('1. a balanced charge posts, reads back exactly, audits once and replays under the same key', async () => {
    const patient = await createPatient(h, 'Synthetic Ledger');
    const key = randomUUID();
    const body = {
      patientRef: patient,
      procedureRef: procedureRef(),
      procedureCode: 'SYN-EXAM1',
      serviceDate: '2026-10-01',
      amount: usd(12345),
    };
    const first = h.ok<{ data: { chargeRef: string; entryRef: string }; version: number; replayed: boolean }>(
      await h.call('a1', 'POST', CHARGES, body, key),
      201,
    );
    expect([first.version, first.replayed]).toStrictEqual([1, false]);
    const again = h.ok<{ data: { chargeRef: string; entryRef: string }; replayed: boolean }>(
      await h.call('a1', 'POST', CHARGES, body, key),
      201,
    );
    expect(again).toMatchObject({ data: first.data, replayed: true });
    const e = await entry(first.data.entryRef);
    expect(e).toMatchObject({
      kind: 'charge',
      currency: 'USD',
      chargeRef: first.data.chargeRef,
      reversesEntryRef: null,
      reversedByEntryRef: null,
      serviceDate: '2026-10-01',
      postedByRef: USER_A1,
    });
    expect(e.lines.map((l) => [l.account, l.amount])).toStrictEqual([
      ['patient_receivable', usd(12345)],
      ['production_revenue', usd(-12345)],
    ]);
    const charge = h.ok<{ data: Record<string, unknown> }>(
      await h.call('a1', 'GET', `${CHARGES}/${first.data.chargeRef}`),
    ).data;
    expect(charge).toMatchObject({
      patientRef: patient,
      amount: usd(12345),
      state: 'posted',
      patientResponsibility: usd(12345),
      insurerResponsibility: [],
      allocated: usd(0),
      procedureCode: 'SYN-EXAM1',
      version: 1,
    });
    const bal = await balanceOf(h, patient);
    expect(bal).toMatchObject({
      patientRef: patient,
      accountPatientRef: patient,
      coveredPatientRefs: [patient],
      currency: 'USD',
      patientResponsibility: usd(12345),
      insurerResponsibility: usd(0),
      unappliedCredit: usd(0),
      balance: usd(12345),
      entryCount: 1,
    });
    const audit = await db.admin.query(
      `SELECT operation, resource_type, resource_version FROM cuspatlas.audit_events WHERE resource_ref = $1`,
      [first.data.chargeRef],
    );
    expect(audit.rows).toStrictEqual([
      { operation: 'billing.charges.post', resource_type: 'billingCharge', resource_version: 1 },
    ]);
    const outbox = await db.admin.query(
      'SELECT payload_class, payload FROM cuspatlas.outbox_events WHERE aggregate_id = $1',
      [first.data.chargeRef],
    );
    expect(outbox.rows).toStrictEqual([
      { payload_class: 'field-names-only', payload: { changedFields: ['charge'] } },
    ]);
    const { rows } = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.billing_journal_entries WHERE charge_id = $1',
      [first.data.chargeRef],
    );
    expect(rows[0].n).toBe(1);
  });

  it('2. malformed money and caller text are refused before any write; the marker never leaks', async () => {
    const patient = await createPatient(h, 'Synthetic Malformed');
    const base = {
      patientRef: patient,
      procedureRef: procedureRef(),
      serviceDate: '2026-10-01',
      amount: usd(100),
    };
    const before = await billingDigest(db);
    for (const bad of [
      { ...base, amount: { currency: 'USD', minor: 12.5 } },
      { ...base, amount: { currency: 'USD', minor: '100' } },
      { ...base, amount: { currency: 'usd', minor: 100 } },
      { ...base, amount: { currency: 'USD', minor: 0 } },
      { ...base, amount: { currency: 'USD', minor: -5 } },
      { ...base, amount: { currency: 'USD', minor: 100, scale: 2 } },
      { ...base, amount: { minor: 100 } },
      { ...base, amount: 1.0 },
      { ...base, procedureRef: `syn-proc-${MARKER}` },
      { ...base, procedureCode: MARKER },
      { ...base, serviceDate: MARKER },
      { ...base, tenantId: T_BETA },
    ]) {
      const res = await h.call('a1', 'POST', CHARGES, bad);
      expect([res.statusCode, res.json().code]).toStrictEqual([400, 'invalid_request']);
      expect(res.body).not.toContain(MARKER);
    }
    const rev = await reverse(randomUUID(), { reasonCode: MARKER });
    expect(rev.statusCode).toBe(400);
    expect(await billingDigest(db)).toBe(before);
    expect(await billingLeakSurface(db)).not.toContain(MARKER);
    expect(h.logLines.join('\n')).not.toContain(MARKER);
  });

  it('3. a currency other than the tenant configuration is refused, never converted', async () => {
    const patient = await createPatient(h, 'Synthetic Currency');
    const res = await h.call('a1', 'POST', CHARGES, {
      patientRef: patient,
      procedureRef: procedureRef(),
      serviceDate: '2026-10-01',
      amount: { currency: 'EUR', minor: 500 },
    });
    expect([res.statusCode, res.json().code, res.json().detail?.reason]).toStrictEqual([
      422,
      'validation_failed',
      'currency_mismatch',
    ]);
    // The configured currency, not a constant, decides: beta configured as EUR accepts EUR only.
    await db.admin.query(`INSERT INTO cuspatlas.billing_settings (tenant_id, currency) VALUES ($1, 'EUR')`, [
      T_BETA,
    ]);
    const betaPatient = await createPatient(h, 'Synthetic Beta Currency', 'b1');
    const eur = await h.call('b1', 'POST', CHARGES, {
      patientRef: betaPatient,
      procedureRef: procedureRef(),
      serviceDate: '2026-10-01',
      amount: { currency: 'EUR', minor: 500 },
    });
    expect(eur.statusCode).toBe(201);
    const usdInBeta = await h.call('b1', 'POST', CHARGES, {
      patientRef: betaPatient,
      procedureRef: procedureRef(),
      serviceDate: '2026-10-01',
      amount: usd(500),
    });
    expect(usdInBeta.json().detail?.reason).toBe('currency_mismatch');
    const bad = await h.call('a1', 'GET', `/v1/billing/patients/${patient}/balance?currency=EUR`);
    expect([bad.statusCode, bad.json().detail?.reason]).toStrictEqual([422, 'currency_mismatch']);
    // A future service date is a domain refusal, not a posted charge.
    const future = await h.call('a1', 'POST', CHARGES, {
      patientRef: patient,
      procedureRef: procedureRef(),
      serviceDate: '2099-01-01',
      amount: usd(500),
    });
    expect([future.statusCode, future.json().detail?.reason]).toStrictEqual([422, 'service_date_in_future']);
  });
});

describe('B1 reversal and replacement', () => {
  it('4. a reversal exactly cancels its original and both remain readable', async () => {
    const patient = await createPatient(h, 'Synthetic Reversal');
    const c = await postCharge(h, patient, 9999);
    const res = h.ok<{ data: { entryRef: string; reversesEntryRef: string }; version: number }>(
      await reverse(c.entryRef),
      201,
    );
    expect(res.data.reversesEntryRef).toBe(c.entryRef);
    expect(res.version).toBe(2);
    const original = await entry(c.entryRef);
    const reversal = await entry(res.data.entryRef);
    expect(original.reversedByEntryRef).toBe(res.data.entryRef);
    expect(reversal).toMatchObject({
      kind: 'charge',
      reversesEntryRef: c.entryRef,
      reasonCode: 'posted_in_error',
      chargeRef: c.chargeRef,
    });
    expect(reversal.lines.map((l) => [l.account, l.amount.minor])).toStrictEqual(
      original.lines.map((l) => [l.account, -l.amount.minor]),
    );
    expect((await balanceOf(h, patient)).balance).toStrictEqual(usd(0));
    const charge = h.ok<{ data: Record<string, unknown> }>(
      await h.call('a1', 'GET', `${CHARGES}/${c.chargeRef}`),
    );
    expect(charge.data).toMatchObject({ state: 'reversed', reversalEntryRef: res.data.entryRef, version: 2 });
    const ledger = h.ok<{ data: { entryRef: string }[] }>(
      await h.call('a1', 'GET', `/v1/billing/patients/${patient}/ledger`),
    );
    expect(ledger.data.map((x) => x.entryRef)).toStrictEqual([c.entryRef, res.data.entryRef]);
    // A historical balance is reproducible: before the reversal the charge was owed in full.
    const postedAt = original.postedAt as string;
    const asOf = (await balanceOf(h, patient, `?asOf=${encodeURIComponent(postedAt)}`)) as Record<
      string,
      unknown
    >;
    expect(asOf.balance).toStrictEqual(usd(9999));
  });

  it('5. reversing twice, reversing a reversal and reversing without a reason are refused', async () => {
    const patient = await createPatient(h, 'Synthetic Twice');
    const c = await postCharge(h, patient, 500);
    const first = h.ok<{ data: { entryRef: string } }>(await reverse(c.entryRef), 201);
    const before = await billingDigest(db);
    const second = await reverse(c.entryRef);
    expect([second.statusCode, second.json().detail?.reason]).toStrictEqual([409, 'already_reversed']);
    expect(second.json().detail.blockingRefs).toStrictEqual([
      { kind: 'journalEntry', ref: first.data.entryRef },
    ]);
    const ofReversal = await reverse(first.data.entryRef);
    expect([ofReversal.statusCode, ofReversal.json().detail?.reason]).toStrictEqual([
      409,
      'reversal_not_reversible',
    ]);
    expect((await reverse(c.entryRef, {})).statusCode).toBe(400);
    expect(await billingDigest(db)).toBe(before);
  });

  it('6. a correction is a reversal plus a replacement linked to the original', async () => {
    const patient = await createPatient(h, 'Synthetic Replacement');
    const proc = procedureRef();
    const c = await postCharge(h, patient, 10000, { procedureRef: proc });
    const dup = await h.call('a1', 'POST', CHARGES, {
      patientRef: patient,
      procedureRef: proc,
      serviceDate: '2026-10-01',
      amount: usd(9000),
    });
    expect([dup.statusCode, dup.json().detail?.reason]).toStrictEqual([409, 'charge_already_posted']);
    const early = await h.call('a1', 'POST', CHARGES, {
      patientRef: patient,
      procedureRef: proc,
      serviceDate: '2026-10-01',
      amount: usd(9000),
      replacesChargeRef: c.chargeRef,
    });
    expect([early.statusCode, early.json().detail?.reason]).toStrictEqual([
      409,
      'replaced_charge_not_reversed',
    ]);
    h.ok(await reverse(c.entryRef), 201);
    const other = await h.call('a1', 'POST', CHARGES, {
      patientRef: patient,
      procedureRef: procedureRef(),
      serviceDate: '2026-10-01',
      amount: usd(9000),
      replacesChargeRef: c.chargeRef,
    });
    expect([other.statusCode, other.json().detail?.reason]).toStrictEqual([422, 'replacement_mismatch']);
    const replacement = await postCharge(h, patient, 9000, {
      procedureRef: proc,
      replacesChargeRef: c.chargeRef,
    });
    const view = h.ok<{ data: Record<string, unknown> }>(
      await h.call('a1', 'GET', `${CHARGES}/${replacement.chargeRef}`),
    ).data;
    expect(view.replacesChargeRef).toBe(c.chargeRef);
    const original = h.ok<{ data: Record<string, unknown> }>(
      await h.call('a1', 'GET', `${CHARGES}/${c.chargeRef}`),
    ).data;
    expect(original.replacedByChargeRef).toBe(replacement.chargeRef);
    expect((await balanceOf(h, patient)).balance).toStrictEqual(usd(9000));
    const again = await h.call('a1', 'POST', CHARGES, {
      patientRef: patient,
      procedureRef: proc,
      serviceDate: '2026-10-01',
      amount: usd(9000),
      replacesChargeRef: c.chargeRef,
    });
    expect([again.statusCode, again.json().detail?.reason]).toStrictEqual([409, 'charge_already_replaced']);
  });

  it('7. two concurrent reversals of one entry: exactly one reversal and one typed conflict', async () => {
    const patient = await createPatient(h, 'Synthetic Concurrent');
    const c = await postCharge(h, patient, 777);
    const results = await Promise.all([reverse(c.entryRef), reverse(c.entryRef), reverse(c.entryRef)]);
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toStrictEqual([201, 409, 409]);
    for (const r of results.filter((x) => x.statusCode === 409)) {
      expect(r.json().detail?.reason).toBe('already_reversed');
    }
    const { rows } = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.billing_journal_entries WHERE reverses_entry_id = $1',
      [c.entryRef],
    );
    expect(rows[0].n).toBe(1);
    expect((await balanceOf(h, patient)).balance).toStrictEqual(usd(0));
  });
});

describe('B1 tenant, role and reference refusals', () => {
  it('8. a cross-tenant or forged reference is the same 404 as a missing record, and changes nothing', async () => {
    const patient = await createPatient(h, 'Synthetic Hidden');
    const c = await postCharge(h, patient, 4321);
    const before = await billingDigest(db);
    const strip = (body: Record<string, unknown>) => ({ ...body, correlationId: null });
    const missing = strip((await h.call('a1', 'GET', `/v1/billing/entries/${randomUUID()}`)).json());
    for (const [method, url, body] of [
      ['GET', `/v1/billing/entries/${c.entryRef}`, undefined],
      ['GET', `${CHARGES}/${c.chargeRef}`, undefined],
      ['POST', `/v1/billing/entries/${c.entryRef}/reverse`, { reasonCode: 'posted_in_error' }],
      ['GET', `/v1/billing/patients/${patient}/ledger`, undefined],
      ['GET', `/v1/billing/patients/${patient}/balance`, undefined],
      [
        'POST',
        CHARGES,
        { patientRef: patient, procedureRef: procedureRef(), serviceDate: '2026-10-01', amount: usd(1) },
      ],
    ] as const) {
      const res = await h.call('b1', method, url, body);
      expect([url, res.statusCode]).toStrictEqual([url, 404]);
      expect(strip(res.json())).toStrictEqual(missing);
    }
    for (const url of ['/v1/billing/entries/not-a-ref', `${CHARGES}/not-a-ref`]) {
      expect((await h.call('a1', 'GET', url)).statusCode).toBe(404);
    }
    // A reversal whose original cannot be read fails closed: nothing unlinked is posted.
    expect((await reverse(randomUUID())).statusCode).toBe(404);
    expect(await billingDigest(db)).toBe(before);
    const attempts = await db.admin.query(
      `SELECT DISTINCT reason_code FROM cuspatlas.security_attempt_events WHERE tenant_id = $1 AND operation LIKE 'billing.%'`,
      [T_BETA],
    );
    expect(attempts.rows).toStrictEqual([{ reason_code: 'resource_hidden_or_missing' }]);
  });

  it('9. scopes and principal kinds decide: read-only, no-scope and service principals are refused', async () => {
    const patient = await createPatient(h, 'Synthetic Roles');
    const c = await postCharge(h, patient, 250);
    const post = {
      patientRef: patient,
      procedureRef: procedureRef(),
      serviceDate: '2026-10-01',
      amount: usd(1),
    };
    const a4 = await h.call('a4', 'POST', CHARGES, post);
    expect([a4.statusCode, a4.json().code]).toStrictEqual([403, 'forbidden']);
    expect((await h.call('a4', 'GET', `/v1/billing/patients/${patient}/balance`)).statusCode).toBe(200);
    expect((await h.call(h.a5, 'GET', `/v1/billing/patients/${patient}/ledger`)).statusCode).toBe(403);
    // A service principal (the future C14 driver) may post charges but never reverse them.
    const svc = await postCharge(h, patient, 300, {}, 'svcA1');
    const svcReverse = await h.call('svcA1', 'POST', `/v1/billing/entries/${svc.entryRef}/reverse`, {
      reasonCode: 'posted_in_error',
    });
    expect(svcReverse.statusCode).toBe(403);
    const { rows } = await db.admin.query(
      `SELECT reason_code FROM cuspatlas.security_attempt_events WHERE correlation_id = $1`,
      [svcReverse.headers['x-correlation-id']],
    );
    expect(rows).toStrictEqual([{ reason_code: 'principal_kind_denied' }]);
    expect(
      (await h.call('a3', 'POST', `/v1/billing/entries/${c.entryRef}/reverse`, { reasonCode: 'x' }))
        .statusCode,
    ).toBe(403);
  });

  it('10. MCP and REST give the same outcomes and share one idempotency scope', async () => {
    const patient = await createPatient(h, 'Synthetic Mcp');
    const key = randomUUID();
    const body = {
      patientRef: patient,
      procedureRef: procedureRef(),
      serviceDate: '2026-10-01',
      amount: usd(808),
    };
    const viaMcp = await h.mcp('a1', 'billing_charges_post', { ...body, idempotencyKey: key }, 201);
    expect(viaMcp.code).toBeNull();
    const viaRest = h.ok<{ data: { chargeRef: string }; replayed: boolean }>(
      await h.call('a1', 'POST', CHARGES, body, key),
      201,
    );
    expect(viaRest.replayed).toBe(true);
    expect(viaRest.data.chargeRef).toBe((viaMcp.body.data as { chargeRef: string }).chargeRef);
    const entryRef = (viaMcp.body.data as { entryRef: string }).entryRef;
    const rev = await h.mcp('a1', 'billing_entries_reverse', {
      entryRef,
      reasonCode: 'posted_in_error',
      idempotencyKey: randomUUID(),
    });
    expect(rev.code).toBeNull();
    const again = await h.mcp('a1', 'billing_entries_reverse', {
      entryRef,
      reasonCode: 'posted_in_error',
      idempotencyKey: randomUUID(),
    });
    expect([again.status, again.code, (again.body.detail as { reason: string }).reason]).toStrictEqual([
      409,
      'conflict',
      'already_reversed',
    ]);
    const hidden = await h.mcp('b1', 'billing_entries_get', { entryRef });
    expect([hidden.status, hidden.code]).toStrictEqual([404, 'not_found']);
    const bal = await h.mcp('a4', 'billing_balances_get', { patientRef: patient });
    expect((bal.body.data as { balance: unknown }).balance).toStrictEqual(usd(0));
  });
});

describe('B1 database-level invariants under the runtime role', () => {
  it('11. the runtime role cannot update, delete or truncate posted entries, lines or charges', async () => {
    const patient = await createPatient(h, 'Synthetic Immutable');
    const c = await postCharge(h, patient, 1000);
    const tx = createTenantTransactionRunner(db.app);
    const ctx = ctxFor(T_ALPHA, USER_A1, 'human');
    for (const sql of [
      `UPDATE cuspatlas.billing_journal_lines SET amount_minor = 1 WHERE entry_id = '${c.entryRef}'`,
      `DELETE FROM cuspatlas.billing_journal_lines WHERE entry_id = '${c.entryRef}'`,
      `UPDATE cuspatlas.billing_journal_entries SET reason_code = 'x' WHERE id = '${c.entryRef}'`,
      `DELETE FROM cuspatlas.billing_journal_entries WHERE id = '${c.entryRef}'`,
      `UPDATE cuspatlas.billing_charges SET amount_minor = 1 WHERE id = '${c.chargeRef}'`,
      `DELETE FROM cuspatlas.billing_charges WHERE id = '${c.chargeRef}'`,
      'TRUNCATE cuspatlas.billing_journal_lines',
      `INSERT INTO cuspatlas.billing_settings (tenant_id) VALUES ('${T_ALPHA}')`,
    ]) {
      await expect(tx(ctx, (t) => t.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
    // The version column moves, but only by one, and no fact can move with it.
    await expect(
      tx(ctx, (t) =>
        t.query(`UPDATE cuspatlas.billing_charges SET version = version + 2 WHERE id = $1`, [c.chargeRef]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // Even the owner path is refused by the append-only trigger.
    await expect(
      db.admin.query(`UPDATE cuspatlas.billing_journal_lines SET amount_minor = 1 WHERE entry_id = $1`, [
        c.entryRef,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('12. unbalanced, short, extended and non-negating entries are refused by the database at commit', async () => {
    const patient = await createPatient(h, 'Synthetic Constraint');
    const c = await postCharge(h, patient, 1000);
    const tx = createTenantTransactionRunner(db.app);
    const ctx = ctxFor(T_ALPHA, USER_A1, 'human');
    const before = await billingDigest(db);
    const insertEntry = (
      t: { query: (s: string, v?: unknown[]) => Promise<{ rows: { id: string }[] }> },
      n: number,
      reverses: string | null = null,
    ) =>
      t.query(
        `INSERT INTO cuspatlas.billing_journal_entries (tenant_id, kind, currency, line_count, charge_id, reverses_entry_id,
           reason_code, posted_by, correlation_id)
         VALUES (cuspatlas.current_tenant_id(), 'charge', 'USD', $1, $2, $3, $4, cuspatlas.current_actor_id(), $5) RETURNING id`,
        [n, c.chargeRef, reverses, reverses ? 'posted_in_error' : null, randomUUID()],
      );
    const line = (
      t: { query: (s: string, v?: unknown[]) => Promise<unknown> },
      entryId: string,
      no: number,
      account: string,
      minor: number,
    ) =>
      t.query(
        `INSERT INTO cuspatlas.billing_journal_lines (tenant_id, entry_id, line_no, account, amount_minor, currency, patient_id, charge_id)
         VALUES (cuspatlas.current_tenant_id(), $1, $2, $3, $4, 'USD', $5, $6)`,
        [entryId, no, account, minor, patient, c.chargeRef],
      );
    // Unbalanced.
    await expect(
      tx(ctx, async (t) => {
        const e = (await insertEntry(t, 2)).rows[0]?.id as string;
        await line(t, e, 1, 'patient_receivable', 100);
        await line(t, e, 2, 'production_revenue', -99);
      }),
    ).rejects.toMatchObject({ code: '23514' });
    // One line only (declared two).
    await expect(
      tx(ctx, async (t) => {
        const e = (await insertEntry(t, 2)).rows[0]?.id as string;
        await line(t, e, 1, 'patient_receivable', 100);
      }),
    ).rejects.toMatchObject({ code: '23514' });
    // A balanced pair appended to an already posted entry.
    await expect(
      tx(ctx, async (t) => {
        await line(t, c.entryRef, 3, 'patient_receivable', 5);
        await line(t, c.entryRef, 4, 'production_revenue', -5);
      }),
    ).rejects.toMatchObject({ code: '23514' });
    // A "reversal" that does not exactly negate the original.
    await expect(
      tx(ctx, async (t) => {
        const e = (await insertEntry(t, 2, c.entryRef)).rows[0]?.id as string;
        await line(t, e, 1, 'patient_receivable', -999);
        await line(t, e, 2, 'production_revenue', 999);
      }),
    ).rejects.toMatchObject({ code: '23514' });
    // Over-crediting the receivable (an allocation that exceeds what is owed) breaks a sign rule.
    await expect(
      tx(ctx, async (t) => {
        const e = (await insertEntry(t, 2)).rows[0]?.id as string;
        await line(t, e, 1, 'patient_receivable', -1001);
        await line(t, e, 2, 'production_revenue', 1001);
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await billingDigest(db)).toBe(before);
    expect((await balanceOf(h, patient)).balance).toStrictEqual(usd(1000));
  });

  it('13. a failure inside the posting transaction leaves no charge, entry, audit or outbox row', async () => {
    const patient = await createPatient(h, 'Synthetic Fault');
    const counts = async () =>
      [
        await count(db, 'billing_charges'),
        await count(db, 'billing_journal_entries'),
        await count(db, 'billing_journal_lines'),
        await count(db, 'audit_events'),
        await count(db, 'outbox_events'),
      ].join(',');
    const before = await counts();
    await db.admin.query('REVOKE INSERT ON cuspatlas.outbox_events FROM cuspatlas_app');
    try {
      const res = await h.call('a1', 'POST', CHARGES, {
        patientRef: patient,
        procedureRef: procedureRef(),
        serviceDate: '2026-10-01',
        amount: usd(5000),
      });
      expect(res.statusCode).toBe(500);
    } finally {
      await db.admin.query('GRANT INSERT ON cuspatlas.outbox_events TO cuspatlas_app');
    }
    expect(await counts()).toBe(before);
  });
});

describe('B1 merge and provenance', () => {
  it('14. a merge alters no posted row; the survivor balance covers both; unmerge after a new fact needs review', async () => {
    const survivor = await createPatient(h, 'Synthetic Merge Pair');
    const merged = await createPatient(h, 'Synthetic Merge Pair');
    await postCharge(h, survivor, 1000);
    await postCharge(h, merged, 2500);
    const before = await billingDigest(db);
    const mergeRef = await mergePatients(h, survivor, merged);
    expect(await billingDigest(db)).toBe(before);
    const bal = await balanceOf(h, survivor);
    expect(bal.balance).toStrictEqual(usd(3500));
    expect(bal.accountPatientRef).toBe(survivor);
    expect([...(bal.coveredPatientRefs as string[])].sort()).toStrictEqual([survivor, merged].sort());
    const ofMerged = await balanceOf(h, merged);
    expect([ofMerged.accountPatientRef, ofMerged.balance]).toStrictEqual([survivor, usd(3500)]);
    const toMerged = await h.call('a1', 'POST', CHARGES, {
      patientRef: merged,
      procedureRef: procedureRef(),
      serviceDate: '2026-10-01',
      amount: usd(10),
    });
    expect([toMerged.statusCode, toMerged.json().detail?.reason]).toStrictEqual([409, 'patient_merged']);
    // A financial fact after the merge: the S-D2 probe makes the unmerge need a reconciliation review.
    await postCharge(h, survivor, 40);
    const unmerge = await h.call('a1', 'POST', `/v1/patients/merges/${mergeRef}/unmerge`, {
      reasonCode: 'merged_in_error',
    });
    expect([unmerge.statusCode, unmerge.json().detail?.reason]).toStrictEqual([
      422,
      'reconciliation_review_required',
    ]);
    const reviewed = await h.call('a1', 'POST', `/v1/patients/merges/${mergeRef}/unmerge`, {
      reasonCode: 'reconciliation_review',
      reconciliationReviewRef: 'syn-review-1',
    });
    expect(reviewed.statusCode).toBe(200);
    expect((await balanceOf(h, survivor)).balance).toStrictEqual(usd(1040));
    expect((await balanceOf(h, merged)).balance).toStrictEqual(usd(2500));
  });

  it('15. the balance is reproducible from the listed ledger entries and reads no clinical table', async () => {
    const patient = await createPatient(h, 'Synthetic Reproducible');
    for (const minor of [101, 202, 303]) await postCharge(h, patient, minor);
    const all: { lines: { patientRef: string; account: string; amount: { minor: number } }[] }[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: typeof all; nextCursor: string | null } = h.ok(
        await h.call(
          'a1',
          'GET',
          `/v1/billing/patients/${patient}/ledger?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        ),
      );
      all.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(all).toHaveLength(3);
    const owed = all
      .flatMap((e) => e.lines)
      .filter((l) => l.account === 'patient_receivable')
      .reduce((s, l) => s + l.amount.minor, 0);
    const bal = await balanceOf(h, patient);
    expect(bal.balance).toStrictEqual(usd(owed));
    expect(bal.entryCount).toBe(3);
    const reads = await db.admin.query(
      `SELECT operation, resource_type FROM cuspatlas.sensitive_read_events WHERE $1 = ANY (resource_refs) ORDER BY occurred_at`,
      [patient],
    );
    expect(reads.rows.map((r) => r.operation)).toContain('billing.balances.read');
    // Structural: the billing domain never names a clinical or estimate table in any statement.
    const dir = resolve(__dirname, '../../packages/domain/src/billing');
    const source = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    const tables = [...source.matchAll(/cuspatlas\.([a-z_]+)/g)].map((m) => m[1] as string);
    expect(tables.length).toBeGreaterThan(0);
    for (const t of new Set(tables)) {
      expect([
        t,
        /^(billing_|patients$|patient_relationships$|audit_events$|outbox_events$|command_idempotency$|current_|sensitive_read)/.test(
          t,
        ),
      ]).toStrictEqual([t, true]);
      expect(t).not.toMatch(/clinical|estimate|treatment|encounter|chart|note/);
    }
  });
});
