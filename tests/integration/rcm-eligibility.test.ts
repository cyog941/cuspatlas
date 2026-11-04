import { randomUUID } from 'node:crypto';
import { createTenantTransactionRunner } from '@cuspatlas/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatient, mergePatients, T_ALPHA } from './support/appointment-fixtures';
import {
  type BillingHarness,
  billingDigest,
  billingLeakSurface,
  openBillingHarness,
  postCharge,
  recordCoverage,
  usd,
} from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, USER_A1 } from './support/fixtures';
import { MARKER } from './support/marker';

/**
 * B5: coverage records, eligibility records and coverage provenance (synthetic data only; every rule
 * recommended-pending-billing-approval; live eligibility blocked-on-discovery, B-S3: eligibility is
 * staff-entered or from the fake adapter). Eligibility never implies that a claim will be paid.
 */
let db: TestDatabase;
let h: BillingHarness;

const COV = '/v1/rcm/coverages';
type Summary = Record<string, unknown> & {
  coverageRef: string;
  coverageVersion: number;
  rank: string;
  coverageStatus: string;
  eligibility: (Record<string, unknown> & { freshness: string }) | null;
};
type Coverage = Record<string, unknown> & {
  version: number;
  current: Record<string, unknown>;
  history: (Record<string, unknown> & { coverageVersion: number })[];
  eligibility: (Record<string, unknown> & { eligibilityRef: string; state: string })[];
};
const reason = (res: { statusCode: number; json: () => { code?: string; detail?: { reason?: string } } }) => [
  res.statusCode,
  res.json().code,
  res.json().detail?.reason,
];
const resolve = async (patientRef: string, serviceDate: string, who = 'a1') =>
  h.ok<{ data: { coverages: Summary[] } }>(
    await h.call(who, 'GET', `/v1/rcm/patients/${patientRef}/coverage?serviceDate=${serviceDate}`),
  ).data.coverages;
const read = async (coverageRef: string, who = 'a1') =>
  h.ok<{ data: Coverage }>(await h.call(who, 'GET', `${COV}/${coverageRef}`)).data;
const eligibility = (coverageRef: string, body: Record<string, unknown>, key: string = randomUUID()) =>
  h.call('a1', 'POST', `${COV}/${coverageRef}/eligibility`, body, key);
const today = () => new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  db = await openTestDatabase('rcm_eligibility');
  h = await openBillingHarness(db, { pool: 10, mcp: true });
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

describe('B5 coverage records', () => {
  it('1. coverage is effective-dated and resolves in benefit order for a service date', async () => {
    const patient = await createPatient(h, 'Synthetic Coverage Order');
    const secondary = await recordCoverage(h, patient, {
      payerRef: 'syn-payer-second',
      rank: 'secondary',
      effectiveUntil: '2026-06-30',
    });
    const primary = await recordCoverage(h, patient, { payerRef: 'syn-payer-first', rank: 'primary' });
    const march = await resolve(patient, '2026-03-01');
    expect(march.map((c) => [c.coverageRef, c.rank, c.coverageVersion])).toStrictEqual([
      [primary, 'primary', 1],
      [secondary, 'secondary', 1],
    ]);
    expect(march[0]).toMatchObject({
      payerRef: 'syn-payer-first',
      effectiveFrom: '2026-01-01',
      effectiveUntil: null,
      coverageStatus: 'unknown',
      eligibility: null,
      paymentAssurance: 'none',
    });
    expect((await resolve(patient, '2026-09-01')).map((c) => c.coverageRef)).toStrictEqual([primary]);
    expect(await resolve(patient, '2025-12-31')).toStrictEqual([]);
    expect((await h.call('a1', 'GET', `/v1/rcm/patients/${patient}/coverage`)).statusCode).toBe(400);
  });

  it('2. overlapping coverage of one rank is refused unless an explicit override with a reason is recorded', async () => {
    const patient = await createPatient(h, 'Synthetic Coverage Overlap');
    const first = await recordCoverage(h, patient, { rank: 'primary' });
    const body = {
      patientRef: patient,
      payerRef: 'syn-payer-other',
      rank: 'primary',
      relationshipToSubscriber: 'self',
      memberRef: 'syn-member-overlap',
      effectiveFrom: '2026-05-01',
    };
    const before = await billingDigest(db);
    const refused = await h.call('a1', 'POST', COV, body);
    expect(reason(refused)).toStrictEqual([409, 'conflict', 'overlapping_coverage']);
    expect(refused.json().detail.blockingRefs).toStrictEqual([{ kind: 'coverage', ref: first }]);
    expect(
      reason(
        await h.call('a1', 'POST', COV, {
          ...body,
          effectiveFrom: '2026-05-01',
          effectiveUntil: '2026-04-01',
        }),
      ),
    ).toStrictEqual([422, 'validation_failed', 'invalid_effective_range']);
    expect(await billingDigest(db)).toBe(before);
    const overridden = h.ok<{ data: { coverageRef: string } }>(
      await h.call('a1', 'POST', COV, { ...body, overlapOverride: { reasonCode: 'pending_termination' } }),
      201,
    );
    expect((await read(overridden.data.coverageRef)).current).toMatchObject({
      overlapOverrideReasonCode: 'pending_termination',
    });
    // A different rank never overlaps.
    await recordCoverage(h, patient, { rank: 'secondary', payerRef: 'syn-payer-other' });
  });

  it('3. a change is a new version; earlier versions stay readable and resolution follows the latest', async () => {
    const patient = await createPatient(h, 'Synthetic Coverage History');
    const cov = await recordCoverage(h, patient, { feeScheduleRef: 'syn-fee-2026a' });
    const v1 = await read(cov);
    const change = (expectedVersion: number) =>
      h.call('a1', 'POST', `${COV}/${cov}/versions`, {
        expectedVersion,
        rank: 'primary',
        relationshipToSubscriber: 'self',
        memberRef: 'syn-member-renewed',
        feeScheduleRef: 'syn-fee-2026b',
        effectiveFrom: '2026-01-01',
        effectiveUntil: '2026-12-31',
        reasonCode: 'plan_year_end',
      });
    const changed = h.ok<{ data: { coverageRef: string; coverageVersion: number } }>(
      await change(v1.version),
      201,
    );
    expect(changed.data).toStrictEqual({ coverageRef: cov, coverageVersion: 2 });
    expect(reason(await change(v1.version))).toStrictEqual([409, 'stale_version', undefined]);
    const v2 = await read(cov);
    expect(v2.history.map((v) => [v.coverageVersion, v.feeScheduleRef, v.effectiveUntil])).toStrictEqual([
      [1, 'syn-fee-2026a', null],
      [2, 'syn-fee-2026b', '2026-12-31'],
    ]);
    expect(v2.history[0]).toStrictEqual(v1.history[0]);
    expect(v2.current).toMatchObject({
      coverageVersion: 2,
      memberRef: 'syn-member-renewed',
      reasonCode: 'plan_year_end',
    });
    expect(await resolve(patient, '2027-01-15')).toStrictEqual([]);
    expect((await resolve(patient, '2026-12-31'))[0]).toMatchObject({
      coverageVersion: 2,
      feeScheduleRef: 'syn-fee-2026b',
    });
  });

  it('4. a subscriber who is not the patient is a separate, checked relationship', async () => {
    const patient = await createPatient(h, 'Synthetic Coverage Dependent');
    const subscriber = await createPatient(h, 'Synthetic Coverage Subscriber');
    const cov = await recordCoverage(h, patient, {
      subscriberRef: subscriber,
      relationshipToSubscriber: 'child',
    });
    expect((await read(cov)).current).toMatchObject({
      subscriberRef: subscriber,
      relationshipToSubscriber: 'child',
    });
    const body = {
      patientRef: patient,
      payerRef: 'syn-payer-sub',
      rank: 'tertiary',
      memberRef: 'syn-member-sub',
      effectiveFrom: '2026-01-01',
    };
    expect(
      reason(
        await h.call('a1', 'POST', COV, {
          ...body,
          subscriberRef: patient,
          relationshipToSubscriber: 'spouse',
        }),
      ),
    ).toStrictEqual([422, 'validation_failed', 'subscriber_relationship_mismatch']);
    expect(
      reason(
        await h.call('a1', 'POST', COV, {
          ...body,
          subscriberRef: subscriber,
          relationshipToSubscriber: 'self',
        }),
      ),
    ).toStrictEqual([422, 'validation_failed', 'subscriber_relationship_mismatch']);
    const beta = await createPatient(h, 'Synthetic Coverage Beta', 'b1');
    const hidden = await h.call('a1', 'POST', COV, {
      ...body,
      subscriberRef: beta,
      relationshipToSubscriber: 'spouse',
    });
    const missing = await h.call('a1', 'POST', COV, {
      ...body,
      subscriberRef: randomUUID(),
      relationshipToSubscriber: 'spouse',
    });
    expect([hidden.statusCode, hidden.json().detail]).toStrictEqual([404, missing.json().detail]);
  });
});

describe('B5 eligibility records, freshness and provenance', () => {
  it('5. a staff-entered record is unverified, carries per-group provenance and derives stale outside its window', async () => {
    const patient = await createPatient(h, 'Synthetic Eligibility Entered');
    const cov = await recordCoverage(h, patient);
    const rec = h.ok<{ data: { eligibilityRef: string; state: string } }>(
      await eligibility(cov, {
        source: 'entered',
        serviceDate: today(),
        freshnessHours: 48,
        benefits: {
          activeStatus: 'active',
          limits: [{ kind: 'annual_maximum', amount: usd(150000) }],
          frequencies: [{ categoryCode: 'SYN-PROPHY', count: 2, periodMonths: 12 }],
        },
      }),
      201,
    );
    expect(rec.data.state).toBe('unverified');
    const [now] = await resolve(patient, today());
    expect(now).toMatchObject({
      coverageStatus: 'entered',
      paymentAssurance: 'none',
      eligibility: {
        eligibilityRef: rec.data.eligibilityRef,
        source: 'entered',
        state: 'unverified',
        freshness: 'current',
      },
    });
    const groups = (
      (now as Summary).eligibility as unknown as {
        benefits: Record<string, { provenance: Record<string, unknown> }>;
      }
    ).benefits;
    for (const g of ['status', 'limits', 'frequencies']) {
      expect([g, groups[g]?.provenance]).toMatchObject([g, { source: 'entered', recordedByRef: USER_A1 }]);
    }
    // Outside the window the same query shows the record as stale; it is never silently current.
    const [later] = await resolve(patient, '2027-06-01');
    expect(later).toMatchObject({ coverageStatus: 'stale', eligibility: { freshness: 'stale' } });
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      reason(await eligibility(cov, { source: 'entered', serviceDate: today(), retrievedAt: future })),
    ).toStrictEqual([422, 'validation_failed', 'retrieved_in_future']);
    expect(
      reason(await eligibility(cov, { source: 'fake_adapter', serviceDate: today(), benefits: {} })),
    ).toStrictEqual([422, 'validation_failed', 'benefits_not_allowed']);
  });

  it('6. the fake adapter maps a response, records a timeout as unknown and keeps an unmappable response as raw evidence', async () => {
    const patient = await createPatient(h, 'Synthetic Eligibility Adapter');
    const ok = await recordCoverage(h, patient, { payerRef: 'syn-payer-mapped' });
    const timeout = await recordCoverage(h, patient, { payerRef: 'syn-payer-timeout', rank: 'secondary' });
    const unmapped = await recordCoverage(h, patient, { payerRef: 'syn-payer-unmapped', rank: 'tertiary' });
    const key = randomUUID();
    const verified = h.ok<{ data: { eligibilityRef: string; state: string } }>(
      await eligibility(ok, { source: 'fake_adapter', serviceDate: today() }, key),
      201,
    );
    expect(verified.data.state).toBe('verified');
    const replay = h.ok<{ data: { eligibilityRef: string }; replayed: boolean }>(
      await eligibility(ok, { source: 'fake_adapter', serviceDate: today() }, key),
      201,
    );
    expect([replay.replayed, replay.data.eligibilityRef]).toStrictEqual([true, verified.data.eligibilityRef]);
    const unknown = h.ok<{ data: { state: string } }>(
      await eligibility(timeout, { source: 'fake_adapter', serviceDate: today() }),
      201,
    );
    expect(unknown.data.state).toBe('unknown');
    const raw = h.ok<{ data: { state: string } }>(
      await eligibility(unmapped, { source: 'fake_adapter', serviceDate: today() }),
      201,
    );
    expect(raw.data.state).toBe('unparsed');
    const list = await resolve(patient, today());
    expect(list.map((c) => [c.rank, c.coverageStatus])).toStrictEqual([
      ['primary', 'entered'],
      ['secondary', 'unknown'],
      ['tertiary', 'unknown'],
    ]);
    const mapped = (await read(ok)).eligibility[0] as unknown as Record<string, unknown> & {
      benefits: Record<string, Record<string, unknown>>;
    };
    expect(mapped).toMatchObject({ source: 'fake_adapter', state: 'verified', rawEvidenceDigest: null });
    expect(mapped.benefits.status).toMatchObject({ value: 'active', provenance: { source: 'fake_adapter' } });
    expect(mapped.benefits.limits?.items).toStrictEqual([
      { kind: 'annual_maximum', amount: usd(150000) },
      { kind: 'deductible', amount: usd(5000) },
    ]);
    const timedOut = (await read(timeout)).eligibility[0];
    expect(timedOut).toMatchObject({ state: 'unknown', benefits: {}, rawEvidenceDigest: null });
    const unparsed = (await read(unmapped)).eligibility[0];
    expect(unparsed).toMatchObject({ state: 'unparsed', benefits: {} });
    expect(unparsed?.rawEvidenceDigest).toMatch(/^[0-9a-f]{64}$/);
    // An inactive answer is a verified fact about status, not a claim outcome.
    const inactive = await recordCoverage(h, await createPatient(h, 'Synthetic Inactive'), {
      payerRef: 'syn-payer-inactive',
    });
    h.ok(await eligibility(inactive, { source: 'fake_adapter', serviceDate: today() }), 201);
    expect((await read(inactive)).eligibility[0]).toMatchObject({
      state: 'verified',
      benefits: { status: { value: 'inactive' } },
    });
  });

  it('7. a timeout after a usable record keeps the usable record; earlier records are never rewritten', async () => {
    const patient = await createPatient(h, 'Synthetic Eligibility History');
    const cov = await recordCoverage(h, patient);
    const first = h.ok<{ data: { eligibilityRef: string } }>(
      await eligibility(cov, { source: 'entered', serviceDate: today() }),
      201,
    );
    const snapshot = (await read(cov)).eligibility[0];
    h.ok(await eligibility(cov, { source: 'entered', serviceDate: today(), freshnessHours: 1 }), 201);
    const all = (await read(cov)).eligibility;
    expect(all).toHaveLength(2);
    expect(all.find((e) => e.eligibilityRef === first.data.eligibilityRef)).toStrictEqual(snapshot);
    const tx = createTenantTransactionRunner(db.app);
    const ctx = ctxFor(T_ALPHA, USER_A1, 'human');
    for (const sql of [
      `UPDATE cuspatlas.rcm_eligibility_records SET state = 'verified' WHERE coverage_id = '${cov}'`,
      `DELETE FROM cuspatlas.rcm_eligibility_records WHERE coverage_id = '${cov}'`,
      `UPDATE cuspatlas.rcm_coverage_versions SET member_ref = 'syn-member-x' WHERE coverage_id = '${cov}'`,
      `DELETE FROM cuspatlas.rcm_coverage_versions WHERE coverage_id = '${cov}'`,
      `UPDATE cuspatlas.rcm_coverages SET payer_ref = 'syn-payer-x' WHERE id = '${cov}'`,
      `DELETE FROM cuspatlas.rcm_coverages WHERE id = '${cov}'`,
    ]) {
      await expect(tx(ctx, (t) => t.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
  });
});

describe('B5 coverage seam, isolation and parity', () => {
  it('8. insurer responsibility names a coverage of the charge patient effective on the service date', async () => {
    const patient = await createPatient(h, 'Synthetic Coverage Seam');
    const other = await createPatient(h, 'Synthetic Coverage Other');
    const cov = await recordCoverage(h, patient, { payerRef: 'syn-payer-seam' });
    const foreign = await recordCoverage(h, other);
    const late = await recordCoverage(h, patient, { rank: 'secondary', effectiveFrom: '2026-11-01' });
    const c = await postCharge(h, patient, 10000);
    const url = `/v1/billing/charges/${c.chargeRef}/responsibility`;
    const move = (coverageRef: string) =>
      h.call('a1', 'POST', url, {
        direction: 'to_insurer',
        coverageRef,
        amount: usd(4000),
        reasonCode: 'coverage_expected',
      });
    expect(reason(await move(foreign))).toStrictEqual([
      422,
      'validation_failed',
      'coverage_patient_mismatch',
    ]);
    expect(reason(await move(late))).toStrictEqual([422, 'validation_failed', 'coverage_not_effective']);
    const beta = await recordCoverage(h, await createPatient(h, 'Synthetic Beta Seam', 'b1'), {}, 'b1');
    const hidden = await move(beta);
    const missing = await move(randomUUID());
    expect([hidden.statusCode, hidden.json().detail]).toStrictEqual([404, missing.json().detail]);
    const moved = h.ok<{ data: { entryRef: string } }>(await move(cov), 201);
    expect(
      h.ok<{ data: Record<string, unknown> }>(await h.call('a1', 'GET', `/v1/billing/charges/${c.chargeRef}`))
        .data,
    ).toMatchObject({
      patientResponsibility: usd(6000),
      insurerResponsibility: [{ coverageRef: cov, payerRef: 'syn-payer-seam', amount: usd(4000) }],
    });
    const entry = h.ok<{ data: { lines: { account: string; coverageRef: string | null }[] } }>(
      await h.call('a1', 'GET', `/v1/billing/entries/${moved.data.entryRef}`),
    ).data;
    expect(entry.lines.find((l) => l.account === 'insurer_receivable')?.coverageRef).toBe(cov);
    // A legacy payer reference is no longer accepted as the insurer dimension.
    expect(
      (
        await h.call('a1', 'POST', url, {
          direction: 'to_insurer',
          payerRef: 'syn-payer-seam',
          amount: usd(1),
          reasonCode: 'coverage_expected',
        })
      ).statusCode,
    ).toBe(400);
  });

  it("9. a merged identity's coverage resolves under the survivor; another tenant is hidden; scopes are checked", async () => {
    const survivor = await createPatient(h, 'Synthetic Coverage Merge');
    const merged = await createPatient(h, 'Synthetic Coverage Merge');
    const cov = await recordCoverage(h, merged);
    await mergePatients(h, survivor, merged);
    expect((await resolve(survivor, '2026-03-01')).map((c) => c.coverageRef)).toStrictEqual([cov]);
    expect(
      reason(
        await h.call('a1', 'POST', COV, {
          patientRef: merged,
          payerRef: 'syn-payer-merge',
          rank: 'secondary',
          relationshipToSubscriber: 'self',
          memberRef: 'syn-member-merge',
          effectiveFrom: '2026-01-01',
        }),
      ),
    ).toStrictEqual([409, 'conflict', 'patient_merged']);
    const missing = randomUUID();
    for (const [method, suffix, body] of [
      ['GET', '', undefined],
      ['POST', '/eligibility', { source: 'entered', serviceDate: '2026-03-01' }],
      [
        'POST',
        '/versions',
        {
          expectedVersion: 1,
          rank: 'primary',
          relationshipToSubscriber: 'self',
          memberRef: 'syn-member-x',
          effectiveFrom: '2026-01-01',
          reasonCode: 'x',
        },
      ],
    ] as const) {
      const hiddenRes = await h.call('b1', method, `${COV}/${cov}${suffix}`, body);
      const absent = await h.call('a1', method, `${COV}/${missing}${suffix}`, body);
      expect([suffix, hiddenRes.statusCode, hiddenRes.json().detail]).toStrictEqual([
        suffix,
        404,
        absent.json().detail,
      ]);
    }
    expect(
      (await h.call('b1', 'GET', `/v1/rcm/patients/${survivor}/coverage?serviceDate=2026-03-01`)).statusCode,
    ).toBe(404);
    expect((await h.call(h.a5, 'GET', `${COV}/${cov}`)).statusCode).toBe(403);
    expect((await h.call('a4', 'GET', `${COV}/${cov}`)).statusCode).toBe(200);
    expect(
      (await eligibility(cov, { source: 'entered', serviceDate: '2026-03-01' }, randomUUID())).statusCode,
    ).toBe(201);
    expect(
      (
        await h.call('a4', 'POST', `${COV}/${cov}/eligibility`, {
          source: 'entered',
          serviceDate: '2026-03-01',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('10. MCP gives the same coverage outcomes; caller strings are closed patterns and never leak', async () => {
    const patient = await createPatient(h, 'Synthetic Coverage Mcp');
    const rec = await h.mcp(
      'a1',
      'rcm_coverages_record',
      {
        patientRef: patient,
        payerRef: 'syn-payer-mcp',
        rank: 'primary',
        relationshipToSubscriber: 'self',
        memberRef: 'syn-member-mcp',
        effectiveFrom: '2026-01-01',
        idempotencyKey: randomUUID(),
      },
      201,
    );
    const cov = (rec.body.data as { coverageRef: string }).coverageRef;
    const dup = await h.mcp('a1', 'rcm_coverages_record', {
      patientRef: patient,
      payerRef: 'syn-payer-mcp2',
      rank: 'primary',
      relationshipToSubscriber: 'self',
      memberRef: 'syn-member-mcp',
      effectiveFrom: '2026-01-01',
      idempotencyKey: randomUUID(),
    });
    expect([dup.status, (dup.body.detail as { reason: string }).reason]).toStrictEqual([
      409,
      'overlapping_coverage',
    ]);
    const viaMcp = await h.mcp('a4', 'rcm_coverages_resolve', {
      patientRef: patient,
      serviceDate: '2026-03-01',
    });
    expect((viaMcp.body.data as { coverages: Summary[] }).coverages).toStrictEqual(
      await resolve(patient, '2026-03-01', 'a4'),
    );
    const hidden = await h.mcp('b1', 'rcm_coverages_get', { coverageRef: cov });
    expect([hidden.status, hidden.code]).toStrictEqual([404, 'not_found']);
    const base = {
      patientRef: patient,
      payerRef: 'syn-payer-leak',
      rank: 'secondary',
      relationshipToSubscriber: 'self',
      memberRef: 'syn-member-leak',
      effectiveFrom: '2026-01-01',
    };
    for (const [url, body] of [
      [COV, { ...base, payerRef: MARKER }],
      [COV, { ...base, memberRef: MARKER }],
      [COV, { ...base, groupRef: MARKER }],
      [COV, { ...base, feeScheduleRef: MARKER }],
      [COV, { ...base, overlapOverride: { reasonCode: MARKER } }],
      [COV, { ...base, tenantId: T_ALPHA }],
      [
        `${COV}/${cov}/eligibility`,
        {
          source: 'entered',
          serviceDate: '2026-03-01',
          benefits: { frequencies: [{ categoryCode: MARKER, count: 1, periodMonths: 12 }] },
        },
      ],
      [`${COV}/${cov}/eligibility`, { source: 'entered', serviceDate: '2026-03-01', freshnessHours: 1.5 }],
    ] as const) {
      const r = await h.call('a1', 'POST', url, body);
      expect([url, r.statusCode]).toStrictEqual([url, 400]);
      expect(r.body).not.toContain(MARKER);
    }
    expect(await billingLeakSurface(db)).not.toContain(MARKER);
    expect(h.logLines.join('\n')).not.toContain(MARKER);
  });
});
