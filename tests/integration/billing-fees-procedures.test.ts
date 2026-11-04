import { randomUUID } from 'node:crypto';
import { RefusalError } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
} from '@cuspatlas/db';
import { createAuthorize } from '@cuspatlas/domain';
import { createWorker } from '@cuspatlas/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatient, T_ALPHA, T_BETA } from './support/appointment-fixtures';
import { BILLING_ALL, usd } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { FakeProvider } from './support/fake-provider';
import { ctxFor, SVC_B1, USER_A2, USER_A3 } from './support/fixtures';
import { openRcmHarness, RCM_LOC, type RcmHarness, SVC_BILLING_WORKER } from './support/rcm-fixtures';

/**
 * B9 fee schedules, adjustments and report scope, and the C14 -> B consumer (synthetic data only;
 * SYN- placeholder codes; rules pending billing approval). A charge exists only for a rendered
 * procedure, priced by the practice schedule version effective on its date of service, once per
 * procedure event version under retries, duplicates and concurrency.
 */
let db: TestDatabase;
let r: RcmHarness;
const reason = (res: { statusCode: number; json: () => { code?: string; detail?: { reason?: string } } }) => [
  res.statusCode,
  res.json().code,
  res.json().detail?.reason,
];
const chargesOf = async (procedureRef: string) =>
  (
    await db.admin.query(
      `SELECT c.id, c.amount_minor::text AS amount, c.procedure_code, c.fee_schedule_version_id, c.replaces_charge_id
       FROM cuspatlas.billing_charges c WHERE c.procedure_ref = $1`,
      [procedureRef],
    )
  ).rows;
const patientOpen = async (chargeRef: string) =>
  r.h.ok<{ data: { patientResponsibility: { minor: number } } }>(
    await r.h.call('a1', 'GET', `/v1/billing/charges/${chargeRef}`),
  ).data.patientResponsibility.minor;
const correct = async (procedureRef: string, codeRef: string) =>
  r.h.ok<{ data: { reversal: { procedureRef: string }; replacement: { procedureRef: string } } }>(
    await r.h.call('a1', 'POST', `/v1/clinical/procedures/${procedureRef}/corrections`, {
      reasonCode: 'wrong_code',
      replacement: { codeRef },
    }),
    201,
  ).data;

beforeAll(async () => {
  db = await openTestDatabase('billing_fees_procedures');
  r = await openRcmHarness(db);
  await r.publishFee('syn-fee-standard', [
    ['SYN-FEE-100', 12000],
    ['SYN-FEE-200', 8000],
    ['SYN-LONG-CODE-WITH-HYPHENS-01', 4500],
  ]);
});

afterAll(async () => {
  await r?.h.close();
  await db?.close();
});

describe('B9 fee schedules', () => {
  it('1. versions are effective-dated, never inserted before the latest, and resolve per date', async () => {
    const h = r.h;
    await r.publishFee('syn-fee-dated', [['SYN-DATED-1', 1000]], { locationRef: RCM_LOC });
    await r.publishFee('syn-fee-dated', [['SYN-DATED-1', 1500]], {
      locationRef: RCM_LOC,
      effectiveFrom: '2026-06-01',
    });
    const fee = async (date: string) =>
      h.ok<{ data: { practice: { fee: { minor: number }; versionNo: number } | null } }>(
        await h.call(
          'a1',
          'GET',
          `/v1/billing/fees?codeRef=SYN-DATED-1&serviceDate=${date}&locationRef=${RCM_LOC}`,
        ),
      ).data.practice;
    expect([(await fee('2026-03-01'))?.fee.minor, (await fee('2026-03-01'))?.versionNo]).toStrictEqual([
      1000, 1,
    ]);
    expect((await fee('2026-07-01'))?.fee.minor).toBe(1500);
    expect(await fee('2025-12-31')).toBeNull();
    const early = await h.call('a1', 'POST', '/v1/billing/fee-schedules/versions', {
      scheduleRef: 'syn-fee-dated',
      purpose: 'practice',
      locationRef: RCM_LOC,
      effectiveFrom: '2026-02-01',
      items: [{ codeRef: 'SYN-DATED-1', fee: usd(1) }],
    });
    expect(reason(early)).toStrictEqual([409, 'conflict', 'effective_date_out_of_order']);
    // A same-day correction is a higher version; it never reprices history.
    await r.publishFee('syn-fee-dated', [['SYN-DATED-1', 1400]], {
      locationRef: RCM_LOC,
      effectiveFrom: '2026-06-01',
      reasonCode: 'typo_corrected',
    });
    expect([(await fee('2026-07-01'))?.fee.minor, (await fee('2026-07-01'))?.versionNo]).toStrictEqual([
      1400, 3,
    ]);
    expect((await fee('2026-03-01'))?.fee.minor).toBe(1000);
    // A service without the read scope is refused; the denial is the same whether or not data exists.
    expect(
      (await h.call('a5', 'GET', '/v1/billing/fees?codeRef=SYN-DATED-1&serviceDate=2026-03-01')).statusCode,
    ).toBe(403);
  });
});

describe('C14 -> B consumer', () => {
  it('2. one charge per rendered procedure, priced and versioned, under duplicates and concurrency', async () => {
    const p = await createPatient(r.h, 'Synthetic Consumer Once');
    const e = await r.encounter(p);
    const proc = await r.render(e, 'SYN-FEE-100');
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => r.consume(proc)));
    expect(results.map((x) => x.statusCode)).toStrictEqual([200, 200, 200, 200, 200]);
    const refs = new Set(results.map((x) => x.json().data.chargeRef));
    expect(refs.size).toBe(1);
    expect(results.filter((x) => x.json().data.replayed === false)).toHaveLength(1);
    const rows = await chargesOf(proc);
    expect(rows).toHaveLength(1);
    expect([rows[0].amount, rows[0].procedure_code, rows[0].fee_schedule_version_id === null]).toStrictEqual([
      '12000',
      'SYN-FEE-100',
      false,
    ]);
    // A later schedule version never reprices the posted charge.
    await r.publishFee('syn-fee-standard', [['SYN-FEE-100', 99000]], { effectiveFrom: '2026-01-02' });
    expect((await r.consume(proc)).json().data.replayed).toBe(true);
    expect((await chargesOf(proc))[0].amount).toBe('12000');
    await r.publishFee(
      'syn-fee-standard',
      [
        ['SYN-FEE-100', 12000],
        ['SYN-FEE-200', 8000],
        ['SYN-LONG-CODE-WITH-HYPHENS-01', 4500],
      ],
      { effectiveFrom: '2026-01-03' },
    );
  });

  it('3. a UUID procedure and a 29-character SYN- code with hyphens are accepted', async () => {
    const p = await createPatient(r.h, 'Synthetic Long Code');
    const proc = await r.render(await r.encounter(p), 'SYN-LONG-CODE-WITH-HYPHENS-01');
    expect(proc).toMatch(/^[0-9a-f-]{36}$/);
    r.h.ok(await r.consume(proc));
    expect((await chargesOf(proc))[0].procedure_code).toBe('SYN-LONG-CODE-WITH-HYPHENS-01');
  });

  it('4. a correction posts the reversal, then the linked replacement; out of order is retried', async () => {
    const p = await createPatient(r.h, 'Synthetic Corrected Charge');
    const proc = await r.render(await r.encounter(p), 'SYN-FEE-100');
    const original = r.h.ok<{ data: { chargeRef: string } }>(await r.consume(proc)).data.chargeRef;
    const c = await correct(proc, 'SYN-FEE-200');
    const early = await r.consume(c.replacement.procedureRef);
    expect([...reason(early), early.json().retryable]).toStrictEqual([
      409,
      'conflict',
      'replaced_charge_not_reversed',
      true,
    ]);
    const rev = r.h.ok<{ data: { chargeRef: string; eventType: string } }>(
      await r.consume(c.reversal.procedureRef),
    );
    expect([rev.data.chargeRef, rev.data.eventType]).toStrictEqual([original, 'procedure.reversed.v1']);
    expect((await r.consume(c.reversal.procedureRef)).json().data.replayed).toBe(true);
    const repl = r.h.ok<{ data: { chargeRef: string } }>(await r.consume(c.replacement.procedureRef)).data
      .chargeRef;
    const rows = await chargesOf(c.replacement.procedureRef);
    expect([rows[0].replaces_charge_id, rows[0].amount]).toStrictEqual([original, '8000']);
    expect([await patientOpen(original), await patientOpen(repl)]).toStrictEqual([0, 8000]);
  });

  it('5. no configured fee is a retryable refusal that posts nothing (never a guessed amount)', async () => {
    const p = await createPatient(r.h, 'Synthetic Unpriced');
    const proc = await r.render(await r.encounter(p), 'SYN-NOT-PRICED');
    const res = await r.consume(proc);
    expect([...reason(res), res.json().retryable]).toStrictEqual([
      409,
      'conflict',
      'fee_not_configured',
      true,
    ]);
    expect(await chargesOf(proc)).toStrictEqual([]);
  });

  it('6. the worker consumes procedure events once, also when an event is leased again', async () => {
    const p = await createPatient(r.h, 'Synthetic Worker Consumed');
    const proc = await r.render(await r.encounter(p), 'SYN-FEE-200');
    const worker = createWorker({
      workerPrincipalId: SVC_BILLING_WORKER,
      withTenantTransaction: createTenantTransactionRunner(db.app),
      authorize: createAuthorize(createMembershipSource(db.app)),
      memberships: createMembershipSource(db.app),
      attempts: createSecurityAttemptSink(db.sink),
      backoffSeconds: () => 0,
      procedures: r.service(),
    });
    const adapter = new FakeProvider();
    for (let i = 0; i < 20; i += 1) if ((await worker.runOnce(T_ALPHA, adapter)).length === 0) break;
    const state = async () =>
      (
        await db.admin.query(
          `SELECT state, last_outcome FROM cuspatlas.outbox_events
           WHERE aggregate_type = 'clinicalRenderedProcedure' AND aggregate_id = $1`,
          [proc],
        )
      ).rows[0];
    expect(await state()).toStrictEqual({ state: 'delivered', last_outcome: 'executed' });
    expect(await chargesOf(proc)).toHaveLength(1);
    // A duplicate delivery (the event made ready again) consumes as a replay: still one charge.
    const c = await db.admin.connect();
    try {
      await c.query('SET session_replication_role = replica');
      await c.query(
        `UPDATE cuspatlas.outbox_events SET state = 'retry', next_attempt_at = now() - interval '1 second'
         WHERE aggregate_type = 'clinicalRenderedProcedure' AND aggregate_id = $1`,
        [proc],
      );
    } finally {
      await c.query('SET session_replication_role = origin');
      c.release();
    }
    for (let i = 0; i < 5; i += 1) if ((await worker.runOnce(T_ALPHA, adapter)).length === 0) break;
    expect((await state()).state).toBe('delivered');
    expect(await chargesOf(proc)).toHaveLength(1);
  });

  it('7. denials: a human, another tenant, a revoked or downgraded principal never post a charge', async () => {
    const p = await createPatient(r.h, 'Synthetic Consumer Denials');
    const proc = await r.render(await r.encounter(p), 'SYN-FEE-100');
    const human = await r.h.call('a1', 'POST', `/v1/billing/procedure-events/${proc}/consume`, {});
    expect(human.statusCode).toBe(403);
    const svc = r.service();
    const refusal = async (ctx: ReturnType<typeof ctxFor>) => {
      try {
        await svc.consumeRenderedProcedure(ctx, proc);
        return 'posted';
      } catch (err) {
        return err instanceof RefusalError ? `${err.code}:${err.reasonCode ?? ''}` : 'fault';
      }
    };
    expect(await refusal(ctxFor(T_BETA, SVC_B1, 'service', BILLING_ALL))).toBe(
      'not_found:resource_hidden_or_missing',
    );
    expect(await refusal(ctxFor(T_ALPHA, USER_A2, 'human', BILLING_ALL))).toMatch(/^forbidden:/);
    await db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = now() WHERE principal_id = $1', [
      SVC_BILLING_WORKER,
    ]);
    expect(await refusal(ctxFor(T_ALPHA, SVC_BILLING_WORKER, 'service', BILLING_ALL))).toBe(
      'forbidden:membership_inactive',
    );
    await db.admin.query('UPDATE cuspatlas.memberships SET revoked_at = NULL WHERE principal_id = $1', [
      SVC_BILLING_WORKER,
    ]);
    expect(await chargesOf(proc)).toStrictEqual([]);
  });
});

describe('B9 adjustments and report scope', () => {
  async function chargeFor(given: string, code = 'SYN-FEE-100') {
    const p = await createPatient(r.h, given);
    const proc = await r.render(await r.encounter(p), code);
    return {
      patient: p,
      charge: r.h.ok<{ data: { chargeRef: string } }>(await r.consume(proc)).data.chargeRef,
    };
  }
  const adjust = (chargeRef: string, body: Record<string, unknown>, who: 'a1' | 'a3' = 'a1') =>
    r.h.call(who, 'POST', `/v1/billing/charges/${chargeRef}/adjustments`, body, randomUUID());

  it('8. a write-off is a request posted only by another human; reasons are configured', async () => {
    await db.admin.query(
      "UPDATE cuspatlas.memberships SET scopes = scopes || '{billing.correct}'::text[] WHERE principal_id = $1",
      [USER_A3],
    );
    const { charge } = await chargeFor('Synthetic Write Off');
    expect(
      reason(
        await adjust(charge, {
          kind: 'writeOff',
          responsibility: 'patient',
          amount: usd(500),
          reasonCode: 'mood',
        }),
      ),
    ).toStrictEqual([422, 'validation_failed', 'reason_not_configured']);
    const req = r.h.ok<{ data: { outcome: string; requestRef: string; entryRef: null } }>(
      await adjust(charge, {
        kind: 'writeOff',
        responsibility: 'patient',
        amount: usd(500),
        reasonCode: 'small_balance',
      }),
      201,
    ).data;
    expect(req.outcome).toBe('pending_approval');
    expect(await patientOpen(charge)).toBe(12000);
    const decide = (who: 'a1' | 'a3', decision: string) =>
      r.h.call(
        who,
        'POST',
        `/v1/billing/adjustment-requests/${req.requestRef}/decision`,
        { decision },
        randomUUID(),
      );
    expect((await decide('a1', 'approved')).statusCode).toBe(403);
    const ok = r.h.ok<{ data: { outcome: string; entryRef: string } }>(
      await decide('a3', 'approved'),
      201,
    ).data;
    expect(ok.outcome).toBe('posted');
    expect(await patientOpen(charge)).toBe(11500);
    expect(reason(await decide('a3', 'approved'))).toStrictEqual([409, 'conflict', 'already_decided']);
    const entry = r.h.ok<{ data: { kind: string; reasonCode: string; lines: { account: string }[] } }>(
      await r.h.call('a1', 'GET', `/v1/billing/entries/${ok.entryRef}`),
    ).data;
    expect([entry.kind, entry.reasonCode, entry.lines.map((l) => l.account).sort()]).toStrictEqual([
      'writeOff',
      'small_balance',
      ['adjustment_expense', 'patient_receivable'],
    ]);
    // Corrected by reversal, like every posted entry.
    r.h.ok(
      await r.h.call(
        'a1',
        'POST',
        `/v1/billing/entries/${ok.entryRef}/reverse`,
        { reasonCode: 'posted_in_error' },
        randomUUID(),
      ),
      201,
    );
    expect(await patientOpen(charge)).toBe(12000);
  });

  it('9. a contractual adjustment posts against the insurer receivable; never beyond the balance', async () => {
    const { patient, charge } = await chargeFor('Synthetic Contractual');
    const cov = r.h.ok<{ data: { coverageRef: string } }>(
      await r.h.call('a1', 'POST', '/v1/rcm/coverages', {
        patientRef: patient,
        payerRef: 'syn-payer-contract',
        rank: 'primary',
        relationshipToSubscriber: 'self',
        memberRef: 'syn-member-contract-1',
        effectiveFrom: '2026-01-01',
      }),
      201,
    ).data.coverageRef;
    r.h.ok(
      await r.h.call('a1', 'POST', `/v1/billing/charges/${charge}/responsibility`, {
        direction: 'to_insurer',
        coverageRef: cov,
        amount: usd(10000),
        reasonCode: 'coverage_expected',
      }),
      201,
    );
    const body = {
      kind: 'contractual',
      responsibility: 'insurer',
      coverageRef: cov,
      reasonCode: 'contractual_allowance',
    };
    expect(
      r.h.ok<{ data: { outcome: string } }>(await adjust(charge, { ...body, amount: usd(3000) }), 201).data
        .outcome,
    ).toBe('posted');
    expect(reason(await adjust(charge, { ...body, amount: usd(9000) }))).toStrictEqual([
      409,
      'conflict',
      'adjustment_exceeds_balance',
    ]);
    expect(
      reason(
        await adjust(charge, {
          kind: 'contractual',
          responsibility: 'patient',
          amount: usd(1),
          reasonCode: 'contractual_allowance',
        }),
      ),
    ).toStrictEqual([422, 'validation_failed', 'contractual_is_insurer']);
  });

  it('10. the receivables report needs receivables.read and respects location assignment', async () => {
    const all = r.h.ok<{ data: { scope: string; rows: { locationRef: string | null }[] } }>(
      await r.h.call('a4', 'GET', '/v1/billing/reports/receivables'),
    ).data;
    expect(all.scope).toBe('all_locations');
    expect(all.rows.map((x) => x.locationRef)).toContain(RCM_LOC);
    expect((await r.h.call('a5', 'GET', '/v1/billing/reports/receivables')).statusCode).toBe(403);
    await db.admin.query(
      "UPDATE cuspatlas.memberships SET location_refs = '{loc-elsewhere}' WHERE principal_id = $1",
      [USER_A3],
    );
    try {
      const mine = r.h.ok<{ data: { scope: string; rows: { locationRef: string | null }[] } }>(
        await r.h.call('a3', 'GET', '/v1/billing/reports/receivables'),
      ).data;
      expect(mine.scope).toBe('assigned_locations');
      expect(mine.rows.map((x) => x.locationRef)).not.toContain(RCM_LOC);
      expect(
        (await r.h.call('a3', 'GET', `/v1/billing/reports/receivables?locationRef=${RCM_LOC}`)).statusCode,
      ).toBe(403);
    } finally {
      await db.admin.query('UPDATE cuspatlas.memberships SET location_refs = NULL WHERE principal_id = $1', [
        USER_A3,
      ]);
    }
  });
});
