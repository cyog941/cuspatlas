import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ClaimQueueItem, compareWorkPriority } from '../../packages/domain/src/rcm/claim-queues';
import { createPatient } from './support/appointment-fixtures';
import { usd } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { USER_A4 } from './support/fixtures';
import { openRcmHarness, type RcmHarness, today } from './support/rcm-fixtures';

/**
 * B11 / OR-07 claims work queues and headline measures over synthetic claims driven through the fake
 * clearinghouse (deterministic by payer ref). Queues are predicates: every synthetic claim appears in
 * exactly the queues its facts select, the per-queue counts come in one call, the order is the OR-D3
 * work priority, and the measures reconcile to the journal and the CL-08 worklist.
 */
let db: TestDatabase;
let r: RcmHarness;
const C = '/v1/rcm/claims';
const QUEUES = [
  'to_create',
  'ready_to_submit',
  'attachments_needed',
  'awaiting_payer',
  'rejected_or_denied',
  'appeals',
  'filing_deadline_soon',
  'returned',
  'paid_closed',
  'all',
] as const;
type Q = (typeof QUEUES)[number];
type Result = {
  data: { queue: Q; counts: Record<Q, number>; queueCount: number; items: ClaimQueueItem[] };
  envelope: { count: { exact?: number }; ordering: unknown; truncated: boolean; limit: number };
  vocabularies: Record<string, string>;
};
const post = (url: string, body: unknown) => r.h.call('a1', 'POST', url, body, randomUUID());
const version = async (claimRef: string) =>
  r.h.ok<{ data: { version: number } }>(await r.h.call('a1', 'GET', `${C}/${claimRef}`)).data.version;
const queue = async (q: string, extra = '', who = 'a1') =>
  r.h.ok<Result>(await r.h.call(who, 'GET', `${C}/queues?queue=${q}&limit=100${extra}`));

async function charge(given: string, payerRef: string, code = 'SYN-CLM-100') {
  const patient = await createPatient(r.h, given);
  const coverageRef = r.h.ok<{ data: { coverageRef: string } }>(
    await r.h.call('a1', 'POST', '/v1/rcm/coverages', {
      patientRef: patient,
      payerRef,
      rank: 'primary',
      relationshipToSubscriber: 'self',
      memberRef: `syn-member-${randomUUID().slice(0, 8)}`,
      effectiveFrom: '2026-01-01',
      feeScheduleRef: 'syn-fee-ppo',
    }),
    201,
  ).data.coverageRef;
  r.h.ok(
    await post(`/v1/rcm/coverages/${coverageRef}/eligibility`, {
      source: 'fake_adapter',
      serviceDate: today(),
    }),
    201,
  );
  const proc = await r.render(await r.encounter(patient), code);
  const chargeRef = r.h.ok<{ data: { chargeRef: string } }>(await r.consume(proc)).data.chargeRef;
  return { patient, coverageRef, proc, chargeRef };
}
async function claim(given: string, payerRef: string, code?: string) {
  const s = await charge(given, payerRef, code);
  const claimRef = r.h.ok<{ data: { claimRef: string } }>(
    await post(C, { patientRef: s.patient, coverageRef: s.coverageRef, procedureRefs: [s.proc] }),
    201,
  ).data.claimRef;
  return { ...s, claimRef };
}
const validate = async (claimRef: string) =>
  r.h.ok(await post(`${C}/${claimRef}/validation`, { expectedVersion: await version(claimRef) }), 201);
const submit = async (claimRef: string) =>
  r.h.ok(
    await post(`${C}/${claimRef}/submissions`, {
      expectedVersion: await version(claimRef),
      authorization: { mode: 'explicit' },
    }),
    201,
  );
const poll = (claimRef: string) => post(`${C}/${claimRef}/poll`, {});

/** The synthetic population and, per subject, exactly the queues its facts select. */
const expected = new Map<string, Q[]>();

beforeAll(async () => {
  db = await openTestDatabase('claim_queues');
  r = await openRcmHarness(db, { mcp: true });
  await r.publishFee('syn-fee-standard', [
    ['SYN-CLM-100', 20000],
    ['SYN-ATT-100', 30000],
  ]);
  r.h.ok(
    await r.h.call('a1', 'POST', '/v1/billing/fee-schedules/versions', {
      scheduleRef: 'syn-fee-ppo',
      purpose: 'allowance',
      effectiveFrom: '2026-01-01',
      items: [
        { codeRef: 'SYN-CLM-100', fee: usd(15000) },
        { codeRef: 'SYN-ATT-100', fee: usd(25000) },
      ],
    }),
    201,
  );

  const unclaimed = await charge('Synthetic Queue Unclaimed', 'syn-payer-queues');
  expected.set(unclaimed.chargeRef, ['to_create']);

  const prepared = await claim('Synthetic Queue Prepared', 'syn-payer-queues');
  expected.set(prepared.claimRef, ['all']);

  const ready = await claim('Synthetic Queue Ready', 'syn-payer-queues');
  await validate(ready.claimRef);
  expected.set(ready.claimRef, ['ready_to_submit', 'all']);

  const att = await claim('Synthetic Queue Attachment', 'syn-payer-queues', 'SYN-ATT-100');
  await validate(att.claimRef);
  expected.set(att.claimRef, ['attachments_needed', 'all']);

  const awaiting = await claim('Synthetic Queue Awaiting', 'syn-payer-queues');
  await validate(awaiting.claimRef);
  await submit(awaiting.claimRef);
  expected.set(awaiting.claimRef, ['awaiting_payer', 'all']);

  const returned = await claim('Synthetic Queue Returned', 'syn-payer-reject-queues');
  await validate(returned.claimRef);
  await submit(returned.claimRef);
  expected.set(returned.claimRef, ['returned', 'all']);

  const denied = await claim('Synthetic Queue Denied', 'syn-payer-deny-queues');
  await validate(denied.claimRef);
  await submit(denied.claimRef);
  r.h.ok(await poll(denied.claimRef));
  expected.set(denied.claimRef, ['rejected_or_denied', 'all']);

  const appealed = await claim('Synthetic Queue Appealed', 'syn-payer-deny-queues');
  await validate(appealed.claimRef);
  await submit(appealed.claimRef);
  r.h.ok(await poll(appealed.claimRef));
  const { rows } = await db.admin.query<{ id: string }>(
    "SELECT id FROM cuspatlas.rcm_claim_events WHERE claim_id = $1 AND kind = 'adjudicated_denied'",
    [appealed.claimRef],
  );
  r.h.ok(
    await post(`${C}/${appealed.claimRef}/appeals`, {
      basisCode: 'medical_necessity',
      denialEventRef: rows[0]?.id,
      attachmentRefs: ['syn-img-xray-1'],
    }),
    201,
  );
  expected.set(appealed.claimRef, ['rejected_or_denied', 'appeals', 'all']);

  const paid = await claim('Synthetic Queue Paid', 'syn-payer-queues');
  await validate(paid.claimRef);
  await submit(paid.claimRef);
  r.h.ok(await poll(paid.claimRef));
  expected.set(paid.claimRef, ['paid_closed', 'all']);
});
afterAll(async () => {
  await r?.h.close();
  await db?.close();
});

const key = (i: ClaimQueueItem) => i.claimRef ?? i.chargeRef ?? '';

describe('B11 / OR-07 claims work queues', () => {
  it('every synthetic claim (and the unclaimed charge) is in exactly the queues its predicates select', async () => {
    for (const q of QUEUES) {
      const got = (await queue(q)).data.items.map(key).sort();
      const want = [...expected]
        .filter(([, qs]) => qs.includes(q))
        .map(([k]) => k)
        .sort();
      expect(got, q).toStrictEqual(want);
    }
    const all = await queue('all');
    for (const i of all.data.items) expect(i.queues, key(i)).toStrictEqual(expected.get(key(i)));
  });

  it('per-queue counts come in one call and agree with each queue; the envelope counts exactly', async () => {
    const one = await queue('all');
    for (const q of QUEUES) {
      const want = [...expected.values()].filter((qs) => qs.includes(q)).length;
      expect(one.data.counts[q], q).toBe(want);
      const res = await queue(q);
      expect(res.envelope.count, q).toStrictEqual({ exact: want });
      expect(res.data.queueCount).toBe(want);
    }
    expect(one.envelope).toMatchObject({
      truncated: false,
      ordering: { key: 'workPriority', direction: 'asc', tieBreak: 'claimRef' },
    });
    expect(one.vocabularies).toStrictEqual({ claim: 'billing-state-labels.1' });
    const capped = await queue('all', '', 'a1');
    const page = r.h.ok<Result>(await r.h.call('a1', 'GET', `${C}/queues?queue=all&limit=2`));
    expect(page.data.items).toStrictEqual(capped.data.items.slice(0, 2));
    expect(page.envelope).toMatchObject({
      limit: 2,
      truncated: true,
      count: { exact: capped.data.queueCount },
    });
  });

  it('filing_deadline_soon uses the configurable window (default 30 days) over claims not yet with the payer', async () => {
    expect((await queue('filing_deadline_soon')).data).toMatchObject({
      filingDeadlineDays: 30,
      queueCount: 0,
    });
    const wide = await queue('filing_deadline_soon', '&filingDeadlineDays=400');
    const notWithPayer = [...expected]
      .filter(
        ([, qs]) =>
          qs.some((q) => ['to_create', 'ready_to_submit', 'attachments_needed', 'returned'].includes(q)) ||
          qs.length === 1,
      )
      .map(([k]) => k)
      .sort();
    expect(wide.data.items.map(key).sort()).toStrictEqual(notWithPayer);
    for (const i of wide.data.items) expect(i.daysToDeadline).toBeLessThanOrEqual(400);
    expect((await r.h.call('a1', 'GET', `${C}/queues?filingDeadlineDays=0`)).statusCode).toBe(400);
  });

  it('the order is the documented work priority, stable across calls and transports', async () => {
    const a = (await queue('all', '&filingDeadlineDays=400')).data.items;
    expect([...a].sort(compareWorkPriority)).toStrictEqual(a);
    const b = (await queue('all', '&filingDeadlineDays=400')).data.items;
    expect(b.map(key)).toStrictEqual(a.map(key));
    const m = await r.h.mcp('a1', 'rcm_claims_queues', {
      queue: 'all',
      filingDeadlineDays: '400',
      limit: '100',
    });
    expect((m.body as Result).data.items.map(key)).toStrictEqual(a.map(key));
    // Exception states rank above clean claims at the same deadline distance.
    const sev = (ref: string) => a.find((i) => key(i) === ref)?.exceptionSeverity;
    const ret = [...expected].find(([, qs]) => qs.includes('returned'))?.[0] as string;
    const ready = [...expected].find(([, qs]) => qs.includes('ready_to_submit'))?.[0] as string;
    expect(sev(ret)).toBeGreaterThan(sev(ready) as number);
  });

  it('headline measures declare their definitions and reconcile to the journal and the worklist', async () => {
    const res = r.h.ok<{
      data: {
        asOf: string;
        measures: {
          key: string;
          value: unknown;
          definition: string;
          definitionVersion: string;
          unit: string;
        }[];
      };
    }>(await r.h.call('a1', 'GET', `${C}/measures`));
    const m = Object.fromEntries(res.data.measures.map((x) => [x.key, x]));
    for (const x of res.data.measures) {
      expect(x.definition.length).toBeGreaterThan(20);
      expect(x.definitionVersion).toMatch(new RegExp(`^${x.key}\\.[0-9]+$`));
    }
    const { rows } = await db.admin.query<{ minor: string }>(
      "SELECT coalesce(sum(amount_minor), 0)::text AS minor FROM cuspatlas.billing_journal_lines WHERE account = 'insurer_receivable'",
    );
    expect(m.open_insurer_receivable?.value).toStrictEqual(usd(Number(rows[0]?.minor)));
    expect(m.open_insurer_receivable?.unit).toBe('money');
    const work = r.h.ok<{ data: { data: { claimRef: string }[] } }>(
      await r.h.call('a1', 'GET', `${C}/worklist`),
    ).data.data;
    expect(m.needs_action?.value).toBe(new Set(work.map((w) => w.claimRef)).size);
    expect(m.open_appeals?.value).toBe(1);
    expect(m.claims_over_30_days?.value).toBe(0);
  });

  it('negative: another tenant sees none of these claims; missing scopes are refused', async () => {
    const beta = await queue('all', '', 'b1');
    expect(beta.data.counts.all).toBe(0);
    expect(beta.data.items.filter((i) => expected.has(key(i)))).toStrictEqual([]);
    expect((await r.h.call('a5', 'GET', `${C}/queues`)).statusCode).toBe(403);
    expect((await r.h.call('a5', 'GET', `${C}/measures`)).statusCode).toBe(403);
    expect((await r.h.call('a2', 'GET', `${C}/queues`)).statusCode).toBe(403);
    await db.admin.query(
      "UPDATE cuspatlas.memberships SET scopes = array_remove(scopes, 'receivables.read') WHERE principal_id = $1",
      [USER_A4],
    );
    expect((await r.h.call('a4', 'GET', `${C}/queues`)).statusCode).toBe(200);
    expect((await r.h.call('a4', 'GET', `${C}/measures`)).statusCode).toBe(403);
  });
});
