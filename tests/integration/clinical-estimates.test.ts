import { randomUUID } from 'node:crypto';
import {
  validateEstimateCommandResult,
  validateEstimateList,
  validateEstimateRead,
  validatePlanAlternativeList,
} from '@cuspatlas/contracts';
import { createTenantTransactionRunner } from '@cuspatlas/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AppointmentHarness,
  createPatient,
  leakTables,
  openAppointmentHarness,
  T_ALPHA,
  USER_A1,
} from './support/appointment-fixtures';
import { seedClinicalScopes } from './support/clinical-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor } from './support/fixtures';
import { MARKER } from './support/marker';

/**
 * C12: treatment alternatives, estimates and versioned acceptance (synthetic engineering
 * implementation of C-D7, recommended-pending-approval). Fees are staff-entered synthetic
 * placeholders keyed to an item's fee schedule reference (no fee schedule data; B9 later); coverage
 * is a reference only (B5 not built). Every denial runs under the runtime role.
 */
let db: TestDatabase;
let h: AppointmentHarness;
const PLANS = '/v1/clinical/treatment-plans';
const EST = '/v1/clinical/estimates';
const USD = (minor: number) => ({ currency: 'USD', minor });
const DAY = 86_400_000;
const fresh = () => new Date(Date.now() - DAY).toISOString();
const old = () => new Date(Date.now() - 90 * DAY).toISOString();

beforeAll(async () => {
  db = await openTestDatabase('clinical_estimates');
  h = await openAppointmentHarness(db, { mcp: true });
  await seedClinicalScopes(db.admin);
});

afterAll(async () => {
  await h?.close();
  await db?.close();
});

type Money = { currency: string; minor: number };
type Estimate = {
  estimateRef: string;
  planVersionRef: string;
  number: number;
  state: string;
  supersedesRef: string | null;
  supersededByRef: string | null;
  feeScheduleVersionRef: string | null;
  complete: boolean;
  lines: { planItemRef: string; feeScheduleRef: string; fee: Money }[];
  itemsWithoutFee: string[];
  coverageStatus: string;
  grossAmount: Money | null;
  patientResponsibility: Record<string, unknown>;
  notAGuarantee: true;
  presentation: { coverageStatus: string } | null;
  acceptance: {
    acceptanceRef: string;
    estimateRef: string;
    scope: string;
    estimatePresented: boolean;
    consent: { status: string; consentRefs: string[] };
  } | null;
};
type EResult = { data: Estimate; version: number; replayed: boolean };

const okE = (res: Awaited<ReturnType<AppointmentHarness['call']>>, status = 201) => {
  const json = h.ok<EResult>(res, status);
  expect(validateEstimateCommandResult(json)).toBe(true);
  return json.data;
};
const refusal = (res: Awaited<ReturnType<AppointmentHarness['call']>>) => [
  res.statusCode,
  res.json().detail?.reason ?? res.json().code,
];

async function plan(name: string, fees: [boolean, boolean] = [true, true]) {
  const patientRef = await createPatient(h, name);
  const created = h.ok<{ data: { plan: { planRef: string; headVersionRef: string } } }>(
    await h.call('a1', 'POST', PLANS, { patientRef, displayText: 'Synthetic plan' }, randomUUID()),
    201,
  ).data.plan;
  const versionRef = created.headVersionRef;
  const detail = h.ok<{ data: { targetRef: string } }>(
    await h.call('a1', 'POST', `${PLANS}/versions/${versionRef}/details`, {
      expectedRevision: 1,
      scope: 'whole_mouth',
    }),
    201,
  ).data.targetRef;
  const items: string[] = [];
  for (const [i, withFee] of fees.entries()) {
    items.push(
      h.ok<{ data: { targetRef: string } }>(
        await h.call('a1', 'POST', `${PLANS}/details/${detail}/items`, {
          expectedRevision: 2 + i,
          procedureCodeRef: `SYN-PROC-10${i}`,
          sequence: i + 1,
          ...(withFee ? { feeScheduleRef: `synthetic-fee-${i}` } : {}),
        }),
        201,
      ).data.targetRef,
    );
  }
  return { patientRef, planRef: created.planRef, versionRef, detail, items, revision: 2 + fees.length };
}
const generate = (versionRef: string, body: Record<string, unknown>, who = 'a1', key = randomUUID()) =>
  h.call(who, 'POST', `${PLANS}/versions/${versionRef}/estimates`, body, key);
const present = (estimateRef: string, body: Record<string, unknown> = {}, who = 'a1') =>
  h.call(who, 'POST', `${EST}/${estimateRef}/presentation`, body);
const accept = (estimateRef: string, expectedRevision: number, extra: Record<string, unknown> = {}) =>
  h.call('a1', 'POST', `${EST}/${estimateRef}/acceptance`, { expectedRevision, scope: 'full', ...extra });
const lines = (items: string[], minor = 10_000) =>
  items.map((planItemRef) => ({ planItemRef, fee: USD(minor) }));
async function read(estimateRef: string, who = 'a1') {
  const json = h.ok<{ data: Estimate }>(await h.call(who, 'GET', `${EST}/${estimateRef}`));
  expect(validateEstimateRead(json)).toBe(true);
  return json.data;
}

describe('C12 acceptance cases', () => {
  it('1. two alternatives give two plans and two estimates; accepting one leaves the other retrievable and unselected', async () => {
    const a = await plan('Synthetic Estimate Alt');
    const alt = h.ok<{ data: { plan: { planRef: string; headVersionRef: string } } }>(
      await h.call('a1', 'POST', `${PLANS}/${a.planRef}/alternatives`, { displayText: 'Synthetic alt' }),
      201,
    ).data.plan;
    expect(alt.planRef).not.toBe(a.planRef);
    const altDetail = h.ok<{ data: { targetRef: string } }>(
      await h.call('a1', 'POST', `${PLANS}/versions/${alt.headVersionRef}/details`, {
        expectedRevision: 1,
        scope: 'whole_mouth',
      }),
      201,
    ).data.targetRef;
    const altItem = h.ok<{ data: { targetRef: string } }>(
      await h.call('a1', 'POST', `${PLANS}/details/${altDetail}/items`, {
        expectedRevision: 2,
        procedureCodeRef: 'SYN-PROC-200',
        sequence: 1,
        feeScheduleRef: 'synthetic-fee-alt',
      }),
      201,
    ).data.targetRef;
    const e1 = okE(await generate(a.versionRef, { lines: lines(a.items) }));
    const e2 = okE(await generate(alt.headVersionRef, { lines: lines([altItem], 25_000) }));
    okE(await present(e1.estimateRef), 200);
    okE(await present(e2.estimateRef), 200);
    const accepted = okE(await accept(e1.estimateRef, a.revision));
    expect(accepted.acceptance).toMatchObject({
      estimateRef: e1.estimateRef,
      scope: 'full',
      estimatePresented: true,
      consent: { status: 'outstanding', consentRefs: [] },
    });
    const group = h.ok<{ data: { planRef: string; selection: string; headState: string }[] }>(
      await h.call('a1', 'GET', `${PLANS}/${alt.planRef}/alternatives`),
    );
    expect(validatePlanAlternativeList(group)).toBe(true);
    expect(group.data.map((g) => [g.planRef, g.selection, g.headState])).toStrictEqual([
      [a.planRef, 'accepted', 'accepted'],
      [alt.planRef, 'unselected', 'draft'],
    ]);
    expect((await read(e2.estimateRef)).acceptance).toBeNull();
    // A second alternative of the same problem cannot also be accepted.
    expect(refusal(await accept(e2.estimateRef, 3))).toStrictEqual([409, 'alternative_already_accepted']);
    const plans = h.ok<{ data: { versions: { state: string }[] } }>(
      await h.call('a1', 'GET', `${PLANS}/${alt.planRef}`),
    );
    expect(plans.data.versions.map((v) => v.state)).toStrictEqual(['draft']);
  });

  it('2. a changed coverage assumption creates a new estimate version; the earlier version and its acceptance stay intact', async () => {
    const a = await plan('Synthetic Estimate Versions');
    const coverage = [{ kind: 'coverage', sourceRef: 'synthetic-eligibility-1', sourceAsOf: fresh() }];
    const v1 = okE(await generate(a.versionRef, { lines: lines(a.items), assumptions: coverage }));
    okE(await present(v1.estimateRef), 200);
    okE(await accept(v1.estimateRef, a.revision));
    const before = await read(v1.estimateRef);
    const v2 = okE(
      await generate(a.versionRef, {
        lines: lines(a.items, 12_000),
        assumptions: [{ kind: 'coverage', sourceRef: 'synthetic-eligibility-2', sourceAsOf: fresh() }],
      }),
    );
    expect([v2.number, v2.supersedesRef, v2.acceptance]).toStrictEqual([2, v1.estimateRef, null]);
    const after = await read(v1.estimateRef);
    expect({ ...after, state: before.state, supersededByRef: null }).toStrictEqual(before);
    expect([after.state, after.supersededByRef, after.acceptance?.estimateRef]).toStrictEqual([
      'superseded',
      v2.estimateRef,
      v1.estimateRef,
    ]);
    // The accepted version is never re-bound to the newer estimate.
    okE(await present(v2.estimateRef), 200);
    expect(refusal(await accept(v2.estimateRef, a.revision + 1))).toStrictEqual([
      409,
      'plan_version_accepted',
    ]);
    const list = h.ok<{ data: Estimate[] }>(
      await h.call('a1', 'GET', `${PLANS}/versions/${a.versionRef}/estimates`),
    );
    expect(validateEstimateList(list)).toBe(true);
    expect(list.data.map((e) => [e.number, e.state, e.acceptance === null])).toStrictEqual([
      [1, 'superseded', false],
      [2, 'current', true],
    ]);
  });

  it('3. unknown coverage presents a labelled unknown and never a guaranteed patient responsibility', async () => {
    const a = await plan('Synthetic Estimate Unknown');
    const e = okE(await generate(a.versionRef, { lines: lines(a.items, 15_000) }));
    expect([e.coverageStatus, e.grossAmount, e.patientResponsibility, e.notAGuarantee]).toStrictEqual([
      'unknown',
      USD(30_000),
      { kind: 'unknown', label: 'coverage_unknown' },
      true,
    ]);
    const shown = okE(await present(e.estimateRef), 200);
    expect(shown.presentation?.coverageStatus).toBe('unknown');
    // With an entered coverage reference the figure is a bounded range, labelled as not applied.
    const b = await plan('Synthetic Estimate Range');
    const r = okE(
      await generate(b.versionRef, {
        lines: lines(b.items, 15_000),
        assumptions: [{ kind: 'coverage', sourceRef: 'synthetic-eligibility-3', sourceAsOf: fresh() }],
      }),
    );
    expect([r.coverageStatus, r.patientResponsibility]).toStrictEqual([
      'entered',
      { kind: 'range', low: USD(0), high: USD(30_000), basis: 'coverage_not_applied' },
    ]);
  });

  it('4. an estimate without fee references is incomplete, carries no amount and cannot be presented', async () => {
    const a = await plan('Synthetic Estimate Incomplete', [true, false]);
    const e = okE(await generate(a.versionRef, { lines: lines([a.items[0] as string]) }));
    expect([e.complete, e.grossAmount, e.itemsWithoutFee, e.patientResponsibility]).toStrictEqual([
      false,
      null,
      [a.items[1]],
      { kind: 'not_available', label: 'estimate_incomplete' },
    ]);
    expect(refusal(await present(e.estimateRef))).toStrictEqual([409, 'estimate_incomplete']);
    // A fee for an item that names no fee schedule reference is refused.
    const bad = await generate(a.versionRef, { lines: lines(a.items) });
    expect([bad.statusCode, bad.json().detail?.violations?.[0]?.rule]).toStrictEqual([
      422,
      'itemWithoutFeeScheduleRef',
    ]);
    const mixed = await generate(a.versionRef, {
      lines: [{ planItemRef: a.items[0], fee: { currency: 'EUR', minor: 1 } }, ...lines([])],
    });
    expect(mixed.statusCode).toBe(201);
    const negative = await generate(a.versionRef, { lines: [{ planItemRef: a.items[0], fee: USD(-1) }] });
    expect([negative.statusCode, negative.json().detail?.violations?.[0]?.rule]).toStrictEqual([
      422,
      'negativeFee',
    ]);
  });

  it('5. accepting or presenting a superseded estimate is a typed conflict naming the current version', async () => {
    const a = await plan('Synthetic Estimate Superseded');
    const v1 = okE(await generate(a.versionRef, { lines: lines(a.items) }));
    okE(await present(v1.estimateRef), 200);
    const v2 = okE(await generate(a.versionRef, { lines: lines(a.items, 9_000) }));
    for (const res of [await accept(v1.estimateRef, a.revision), await present(v1.estimateRef)]) {
      expect([res.statusCode, res.json().detail]).toStrictEqual([
        409,
        {
          reason: 'estimate_superseded',
          currentVersion: 2,
          blockingRefs: [{ kind: 'estimate', ref: v2.estimateRef }],
        },
      ]);
    }
    const p = h.ok<{ data: { versions: { state: string }[] } }>(
      await h.call('a1', 'GET', `${PLANS}/${a.planRef}`),
    );
    expect(p.data.versions[0]?.state).toBe('draft');
    // Mixed currencies across lines are refused.
    const mixed = await generate(a.versionRef, {
      lines: [
        { planItemRef: a.items[0], fee: USD(1) },
        { planItemRef: a.items[1], fee: { currency: 'EUR', minor: 1 } },
      ],
    });
    expect([mixed.statusCode, mixed.json().detail?.violations?.[0]?.rule]).toStrictEqual([
      422,
      'mixedCurrency',
    ]);
  });

  it('6. another tenant cannot estimate, read or accept; another patient’s plan item is refused', async () => {
    const a = await plan('Synthetic Estimate Tenancy');
    const other = await plan('Synthetic Estimate Other');
    const e = okE(await generate(a.versionRef, { lines: lines(a.items) }));
    expect((await generate(a.versionRef, { lines: lines(a.items) }, 'b1')).statusCode).toBe(404);
    expect((await h.call('b1', 'GET', `${EST}/${e.estimateRef}`)).statusCode).toBe(404);
    expect((await h.call('b1', 'GET', `${PLANS}/versions/${a.versionRef}/estimates`)).statusCode).toBe(404);
    expect((await present(e.estimateRef, {}, 'b1')).statusCode).toBe(404);
    expect(
      (
        await h.call('b1', 'POST', `${EST}/${e.estimateRef}/acceptance`, {
          expectedRevision: a.revision,
          scope: 'full',
        })
      ).statusCode,
    ).toBe(404);
    expect((await h.call('b1', 'POST', `${PLANS}/${a.planRef}/alternatives`, {})).statusCode).toBe(404);
    const foreign = await generate(a.versionRef, { lines: lines(other.items) });
    expect([foreign.statusCode, foreign.json().detail?.violations?.[0]?.rule]).toStrictEqual([
      422,
      'itemNotInVersion',
    ]);
    const body = await generate(a.versionRef, { lines: lines(a.items), tenantId: T_ALPHA });
    expect(body.statusCode).toBe(400);
  });
});

describe('C12 failure and recovery cases', () => {
  it('1. a coverage reference older than the tolerance is marked stale at generation and at presentation', async () => {
    const a = await plan('Synthetic Estimate Stale');
    const e = okE(
      await generate(a.versionRef, {
        lines: lines(a.items),
        assumptions: [{ kind: 'coverage', sourceRef: 'synthetic-eligibility-old', sourceAsOf: old() }],
      }),
    );
    expect(e.coverageStatus).toBe('stale');
    expect(okE(await present(e.estimateRef), 200).presentation?.coverageStatus).toBe('stale');
    expect(e.patientResponsibility).toMatchObject({ kind: 'range', basis: 'coverage_not_applied' });
  });

  it('2. acceptance racing a new estimate version leaves one linear outcome', async () => {
    const a = await plan('Synthetic Estimate Race');
    const v1 = okE(await generate(a.versionRef, { lines: lines(a.items) }));
    okE(await present(v1.estimateRef), 200);
    const [acc, gen] = await Promise.all([
      accept(v1.estimateRef, a.revision),
      generate(a.versionRef, { lines: lines(a.items, 5_000) }),
    ]);
    expect(gen.statusCode).toBe(201);
    const first = await read(v1.estimateRef);
    if (acc.statusCode === 201) {
      expect(first.acceptance?.estimateRef).toBe(v1.estimateRef);
    } else {
      expect(refusal(acc)).toStrictEqual([409, 'estimate_superseded']);
      expect(first.acceptance).toBeNull();
    }
    const { rows } = await db.admin.query(
      'SELECT count(*)::int AS n FROM cuspatlas.clinical_plan_acceptances WHERE plan_version_id = $1',
      [a.versionRef],
    );
    expect(rows[0].n).toBe(acc.statusCode === 201 ? 1 : 0);
  });

  it('3. a phase-level acceptance is refused, never recorded as full acceptance', async () => {
    const a = await plan('Synthetic Estimate Phases');
    const e = okE(await generate(a.versionRef, { lines: lines(a.items) }));
    okE(await present(e.estimateRef), 200);
    expect(refusal(await accept(e.estimateRef, a.revision, { scope: 'phases', phases: [1] }))).toStrictEqual([
      409,
      'partial_acceptance_unsupported',
    ]);
    expect((await read(e.estimateRef)).acceptance).toBeNull();
  });

  it('4. the fee schedule version an estimate was generated against stays readable on it', async () => {
    const a = await plan('Synthetic Estimate Fee Version');
    const e = okE(
      await generate(a.versionRef, {
        lines: lines(a.items),
        feeScheduleVersionRef: 'synthetic-fee-schedule-v1',
      }),
    );
    expect((await read(e.estimateRef)).feeScheduleVersionRef).toBe('synthetic-fee-schedule-v1');
  });
});

describe('C12 enforcement, privacy and parity', () => {
  it('estimates are append-only and an acceptance reference must be a real acceptance of that version', async () => {
    const a = await plan('Synthetic Estimate Enforcement');
    const e = okE(await generate(a.versionRef, { lines: lines(a.items) }));
    const run = createTenantTransactionRunner(db.app);
    const ctx = ctxFor(T_ALPHA, USER_A1, 'human');
    for (const sql of [
      `UPDATE cuspatlas.clinical_estimates SET gross_minor = 1 WHERE id = '${e.estimateRef}'`,
      `DELETE FROM cuspatlas.clinical_estimates WHERE id = '${e.estimateRef}'`,
      `UPDATE cuspatlas.clinical_estimate_lines SET fee_minor = 1 WHERE estimate_id = '${e.estimateRef}'`,
    ]) {
      await expect(run(ctx, (tx) => tx.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      run(ctx, (tx) =>
        tx.query(
          `UPDATE cuspatlas.clinical_plan_versions SET state = 'accepted', acceptance_ref = $2, accepted_at = now(),
             revision = revision + 1 WHERE id = $1`,
          [a.versionRef, randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    // The database refuses presenting an incomplete estimate even without the domain.
    const b = await plan('Synthetic Estimate Enforcement Two', [false, false]);
    const inc = okE(await generate(b.versionRef, { lines: [] }));
    await expect(
      run(ctx, (tx) =>
        tx.query(
          `INSERT INTO cuspatlas.clinical_estimate_presentations (tenant_id, estimate_id, coverage_status, presented_by)
           VALUES (cuspatlas.current_tenant_id(), $1, 'unknown', cuspatlas.current_actor_id())`,
          [inc.estimateRef],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('a read-only member reads but cannot generate; a service principal cannot generate', async () => {
    const a = await plan('Synthetic Estimate Roles');
    const e = okE(await generate(a.versionRef, { lines: lines(a.items) }));
    expect((await generate(a.versionRef, { lines: lines(a.items) }, 'a4')).statusCode).toBe(403);
    expect((await generate(a.versionRef, { lines: lines(a.items) }, 'svcA1')).statusCode).toBe(403);
    expect((await h.call('a4', 'GET', `${EST}/${e.estimateRef}`)).statusCode).toBe(200);
  });

  it('the marker never leaks; MCP generate replays a REST key and reads match', async () => {
    const a = await plan('Synthetic Estimate Parity');
    await generate(a.versionRef, { lines: lines(a.items), feeScheduleVersionRef: MARKER.slice(0, 20) });
    await h.call('a1', 'POST', `${PLANS}/${a.planRef}/alternatives`, { displayText: `Synthetic ${MARKER}` });
    const key = randomUUID();
    const rest = okE(await generate(a.versionRef, { lines: lines(a.items) }, 'a1', key));
    const viaMcp = await h.mcp(
      'a1',
      'clinical_estimates_generate',
      { planVersionRef: a.versionRef, lines: lines(a.items), idempotencyKey: key },
      201,
    );
    expect([viaMcp.code, (viaMcp.body as { replayed: boolean }).replayed]).toStrictEqual([null, true]);
    const mcpRead = await h.mcp('a1', 'clinical_estimates_get', { estimateRef: rest.estimateRef });
    expect((mcpRead.body as { data: Estimate }).data).toStrictEqual(await read(rest.estimateRef));
    const foreign = await h.mcp('b1', 'clinical_estimates_get', { estimateRef: rest.estimateRef });
    expect([foreign.status, foreign.code]).toStrictEqual([404, 'not_found']);
    const reads = (
      await db.admin.query(
        `SELECT coalesce(json_agg(t)::text, '') AS j FROM cuspatlas.sensitive_read_events t`,
      )
    ).rows[0].j as string;
    expect(`${await leakTables(db)}${reads}${h.logLines.join('\n')}`).not.toContain(MARKER);
  });
});
