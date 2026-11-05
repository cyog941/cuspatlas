import { randomUUID } from 'node:crypto';
import type { BillingExport, SchedulingExport } from '@cuspatlas/contracts';
import { importBillingExport, importSchedulingExport } from '@cuspatlas/db';
import { createFakeClearinghouse } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPatient, T_ALPHA } from './support/appointment-fixtures';
import { BILLING_ALL, type BillingHarness, openBillingHarness, usd } from './support/billing-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';
import { ctxFor, seedTenancy, T_BETA, USER_A1, USER_A3 } from './support/fixtures';
import { openRcmHarness, type RcmHarness, SVC_BILLING_WORKER, today } from './support/rcm-fixtures';

/**
 * B10 billing export round trip (B scope; M1 owns the full export contract): a versioned JSON export of
 * every billing and rcm record (journal, payments, plans, statements, coverage, eligibility, claims,
 * remittances, workflows) with references preserved, no tenant field and every amount as Money,
 * produced under the runtime role; re-imported into a fresh synthetic database by the privileged
 * import (after the S export it references), which validates every foreign key (including tenant-blind
 * single-column keys) and re-verifies the journal invariants; exported again: identical.
 */
let source: TestDatabase;
let target: TestDatabase;
let r: RcmHarness;
let t: BillingHarness;
const fake = createFakeClearinghouse();
const a1 = () => ctxFor(T_ALPHA, USER_A1, 'human', [...BILLING_ALL, 'patients.read', 'patients.write']);
const env = (operation: string, payload: unknown) => ({ operation, idempotencyKey: randomUUID(), payload });
let patient = '';
let claimRef = '';
let workflowRef = '';

type Doc = BillingExport & { tables: Record<string, Record<string, unknown>[]> };
const exportOf = async (h: { ok: BillingHarness['ok']; call: BillingHarness['call'] }) =>
  h.ok<{ data: Doc }>(await h.call('a1', 'GET', '/v1/billing/export')).data;

beforeAll(async () => {
  source = await openTestDatabase('billing_export_source');
  r = await openRcmHarness(source, { mcp: true });
  const svc = r.service({ claims: fake });
  await r.publishFee('syn-fee-standard', [['SYN-EXP-100', 20000]]);
  patient = await createPatient(r.h, 'Synthetic Export');
  const coverageRef = r.h.ok<{ data: { coverageRef: string } }>(
    await r.h.call('a1', 'POST', '/v1/rcm/coverages', {
      patientRef: patient,
      payerRef: 'syn-payer-export',
      rank: 'primary',
      relationshipToSubscriber: 'self',
      memberRef: 'syn-member-export-1',
      effectiveFrom: '2026-01-01',
    }),
    201,
  ).data.coverageRef;
  r.h.ok(
    await r.h.call('a1', 'POST', `/v1/rcm/coverages/${coverageRef}/eligibility`, {
      source: 'fake_adapter',
      serviceDate: today(),
    }),
    201,
  );
  const proc = await r.render(await r.encounter(patient), 'SYN-EXP-100');
  const chargeRef = r.h.ok<{ data: { chargeRef: string } }>(await r.consume(proc)).data.chargeRef;
  claimRef = (
    await svc.prepareClaim(
      a1(),
      env('rcm.claims.prepare', { patientRef: patient, coverageRef, procedureRefs: [proc] }),
    )
  ).data.claimRef;
  workflowRef = (await svc.startClaimWorkflow(a1(), env('rcm.workflows.start', { claimRef }))).data
    .workflowRef;
  await svc.validateClaim(a1(), claimRef, env('rcm.claims.validate', { expectedVersion: 1 }));
  await svc.submitClaim(
    a1(),
    claimRef,
    env('rcm.claims.submit', { expectedVersion: 2, authorization: { mode: 'explicit' } }),
  );
  await svc.pollClaim(a1(), claimRef);
  const eraRef = `syn-era-export-${Date.now().toString(36)}`;
  fake.stageRemittance({
    remittanceRef: eraRef,
    payerRef: 'syn-payer-export',
    currency: 'USD',
    totalPaidMinor: 15000,
    lines: [
      {
        lineNo: 1,
        claimRef,
        claimLineNo: 1,
        paidMinor: 15000,
        contractualMinor: 3000,
        patientResponsibilityMinor: 2000,
      },
    ],
  });
  const rem = (await svc.ingestRemittance(a1(), env('rcm.remittances.ingest', { remittanceRef: eraRef })))
    .data;
  await svc.settleRemittance(
    a1(),
    rem.remittanceRef,
    env('rcm.remittances.settle', { settlementRef: 'syn-eft-export-1', amount: usd(15000) }),
  );
  r.h.ok(
    await r.h.call('a1', 'POST', '/v1/billing/statements', {
      guarantorRef: patient,
      cutoffAt: new Date().toISOString(),
      basis: 'posted_through_cutoff',
    }),
    201,
  );
  const paymentRef = r.h.ok<{ data: { paymentRef: string } }>(
    await r.h.call('a1', 'POST', '/v1/billing/payments', {
      patientRef: patient,
      amount: usd(500),
      method: 'cash',
    }),
    201,
  ).data.paymentRef;
  r.h.ok(
    await r.h.call('a1', 'POST', `/v1/billing/payments/${paymentRef}/allocations`, {
      allocations: [{ chargeRef, amount: usd(500) }],
    }),
    201,
  );
  r.h.ok(
    await r.h.call('a1', 'POST', '/v1/billing/payment-plans', {
      patientRef: patient,
      contractTotal: usd(1500),
      installmentCount: 3,
      firstDueOn: '2026-12-01',
      timeZone: 'America/New_York',
    }),
    201,
  );
  await svc.advanceClaimWorkflow(a1(), workflowRef);
  // A second claim whose ERA line needs review, written off under a policy and approved by another human.
  const patient2 = await createPatient(r.h, 'Synthetic Export Resolution');
  const coverage2 = r.h.ok<{ data: { coverageRef: string } }>(
    await r.h.call('a1', 'POST', '/v1/rcm/coverages', {
      patientRef: patient2,
      payerRef: 'syn-payer-export',
      rank: 'primary',
      relationshipToSubscriber: 'self',
      memberRef: 'syn-member-export-2',
      effectiveFrom: '2026-01-01',
    }),
    201,
  ).data.coverageRef;
  r.h.ok(
    await r.h.call('a1', 'POST', `/v1/rcm/coverages/${coverage2}/eligibility`, {
      source: 'fake_adapter',
      serviceDate: today(),
    }),
    201,
  );
  const proc2 = await r.render(await r.encounter(patient2), 'SYN-EXP-100');
  r.h.ok(await r.consume(proc2));
  const claim2 = (
    await svc.prepareClaim(
      a1(),
      env('rcm.claims.prepare', { patientRef: patient2, coverageRef: coverage2, procedureRefs: [proc2] }),
    )
  ).data.claimRef;
  await svc.validateClaim(a1(), claim2, env('rcm.claims.validate', { expectedVersion: 1 }));
  await svc.submitClaim(
    a1(),
    claim2,
    env('rcm.claims.submit', { expectedVersion: 2, authorization: { mode: 'explicit' } }),
  );
  await svc.pollClaim(a1(), claim2);
  const era2 = `syn-era-export-res-${Date.now().toString(36)}`;
  fake.stageRemittance({
    remittanceRef: era2,
    payerRef: 'syn-payer-export',
    currency: 'USD',
    totalPaidMinor: 10000,
    lines: [
      {
        lineNo: 1,
        claimRef: claim2,
        claimLineNo: 1,
        paidMinor: 10000,
        contractualMinor: 0,
        patientResponsibilityMinor: 0,
      },
    ],
  });
  const rem2 = (await svc.ingestRemittance(a1(), env('rcm.remittances.ingest', { remittanceRef: era2 }))).data
    .remittanceRef;
  await source.admin.query(
    "UPDATE cuspatlas.memberships SET scopes = scopes || '{billing.correct}'::text[] WHERE principal_id = $1",
    [USER_A3],
  );
  await svc.publishWorkflowPolicy(
    a1(),
    env('rcm.workflowPolicies.publish', {
      payerRef: 'syn-payer-export',
      acknowledgementDueMinutes: 60,
      followUpMinutes: 43200,
      exceptionDueMinutes: 1440,
      maxEscalations: 2,
      writeOffLimit: usd(100000),
    }),
  );
  const resolution = (
    await svc.resolveRemittanceLine(
      a1(),
      rem2,
      '1',
      env('rcm.remittances.resolveLine', { action: 'write_off', reasonCode: 'staff_review' }),
    )
  ).data.resolutionRef;
  await svc.decideRemittanceResolution(
    ctxFor(T_ALPHA, USER_A3, 'human', [...BILLING_ALL, 'patients.read', 'patients.write']),
    resolution,
    env('rcm.remittances.decideResolution', { decision: 'approved' }),
  );
  target = await openTestDatabase('billing_export_target');
  t = await openBillingHarness(target);
  await target.admin.query(
    `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'service', 'svc-billing-worker') ON CONFLICT DO NOTHING`,
    [SVC_BILLING_WORKER],
  );
});

afterAll(async () => {
  await t?.close();
  await r?.h.close();
  await target?.close();
  await source?.close();
});

const scheduling = async () =>
  r.h.ok<{ data: SchedulingExport }>(await r.h.call('a1', 'GET', '/v1/scheduling/export')).data;

describe('B10 billing export round trip', () => {
  it('exports every billing and rcm record class, versioned, with Money amounts and no tenant field; REST and MCP agree', async () => {
    const doc = await exportOf(r.h);
    expect(doc.format).toBe('cuspatlas-billing-export/1');
    for (const table of [
      'billing_journal_entries',
      'billing_journal_lines',
      'billing_payments',
      'billing_payment_plans',
      'billing_statements',
      'rcm_coverages',
      'rcm_eligibility_records',
      'rcm_claims',
      'rcm_claim_submissions',
      'rcm_remittances',
      'rcm_remittance_settlements',
      'rcm_claim_workflows',
      'rcm_claim_workflow_steps',
    ])
      expect([table, (doc.tables[table] ?? []).length > 0]).toStrictEqual([table, true]);
    expect(JSON.stringify(doc)).not.toContain(T_ALPHA);
    for (const rows of Object.values(doc.tables))
      for (const row of rows) {
        expect(row).not.toHaveProperty('tenant_id');
        for (const [k, v] of Object.entries(row))
          if (k.endsWith('_minor') && v !== null)
            expect([k, typeof v, Object.keys(v as object).sort()]).toStrictEqual([
              k,
              'object',
              ['currency', 'minor'],
            ]);
      }
    const m = await r.h.mcp('a1', 'billing_export', {});
    expect({ ...(m.body as { data: Doc }).data, exportedAt: null }).toStrictEqual({
      ...doc,
      exportedAt: null,
    });
  });

  it('is refused without admin.configure and to a location-restricted member; another tenant exports only itself', async () => {
    expect((await r.h.call('a4', 'GET', '/v1/billing/export')).statusCode).toBe(403);
    expect((await r.h.call('a3', 'GET', '/v1/billing/export')).statusCode).toBe(403);
    expect((await r.h.call('svcA1', 'GET', '/v1/billing/export')).statusCode).toBe(403);
    const alpha = JSON.stringify(await exportOf(r.h));
    const beta = r.h.ok<{ data: Doc }>(await r.h.call('b1', 'GET', '/v1/billing/export')).data;
    for (const rows of Object.values(beta.tables))
      for (const row of rows) if (typeof row.id === 'string') expect(alpha).not.toContain(row.id);
  });

  it('re-imports into a fresh synthetic database (after the S export), verifies keys and ledger, and exports identically', async () => {
    await importSchedulingExport(target.admin, T_ALPHA, await scheduling());
    const doc = await exportOf(r.h);
    const counts = await importBillingExport(target.admin, T_ALPHA, doc);
    expect(counts.billing_journal_entries).toBe(doc.tables.billing_journal_entries?.length);
    expect(counts.verifiedEntries).toBe(doc.tables.billing_journal_entries?.length);
    const again = await exportOf(t);
    expect({ ...again, exportedAt: null }).toStrictEqual({ ...doc, exportedAt: null });
    // Live domain data on the target: balance, claim and workflow read back identically by reference.
    for (const url of [
      `/v1/billing/patients/${patient}/balance`,
      `/v1/rcm/claims/${claimRef}`,
      `/v1/billing/patients/${patient}/ledger`,
    ]) {
      const stable = (x: unknown) =>
        JSON.parse(JSON.stringify(x, (k, v) => (k === 'asOf' || k === 'checkedAt' ? null : v)));
      const a = stable(r.h.ok<{ data: unknown }>(await r.h.call('a1', 'GET', url)).data);
      const b = stable(t.ok<{ data: unknown }>(await t.call('a1', 'GET', url)).data);
      expect([url, b]).toStrictEqual([url, a]);
    }
  });

  it('the import refuses an unknown format, an unknown table and a malformed amount', async () => {
    const doc = await exportOf(r.h);
    await expect(
      importBillingExport(target.admin, T_ALPHA, { ...doc, format: 'other/9' } as unknown as BillingExport),
    ).rejects.toThrow(/format/);
    await expect(
      importBillingExport(target.admin, T_ALPHA, { ...doc, tables: { ...doc.tables, patients: [] } }),
    ).rejects.toThrow(/Unknown table/);
    const bad = structuredClone(doc);
    const line = bad.tables.billing_journal_lines?.[0] as Record<string, unknown>;
    line.amount_minor = 10.5;
    await expect(importBillingExport(target.admin, T_ALPHA, bad)).rejects.toThrow(/Malformed amount/);
  });

  describe('integrity of the privileged import', () => {
    let fresh: TestDatabase;
    beforeAll(async () => {
      fresh = await openTestDatabase('billing_export_integrity');
      await seedTenancy(fresh.admin);
      await fresh.admin.query(
        `INSERT INTO cuspatlas.principals (id, kind, handle) VALUES ($1, 'service', 'svc-billing-worker'),
           ('20000000-0000-4000-8000-0000000000a5', 'human', 'user-a5') ON CONFLICT DO NOTHING`,
        [SVC_BILLING_WORKER],
      );
      await importSchedulingExport(fresh.admin, T_ALPHA, await scheduling());
    });
    afterAll(async () => {
      await fresh?.close();
    });
    const alphaEntries = async () =>
      (
        await fresh.admin.query(
          'SELECT count(*)::int AS n FROM cuspatlas.billing_journal_entries WHERE tenant_id = $1',
          [T_ALPHA],
        )
      ).rows[0].n;

    it('a tenant-blind single-column key naming another tenant’s row is refused and rolls back', async () => {
      const doc = await exportOf(r.h);
      const foreign = randomUUID();
      const c = await fresh.admin.connect();
      try {
        await c.query('BEGIN');
        await c.query("SET LOCAL session_replication_role = 'replica'");
        await c.query(
          `INSERT INTO cuspatlas.rcm_claim_validations (id, tenant_id, version_id, valid, issues, input_digest, validated_by)
           VALUES ($1, $2, $3, true, '[]'::jsonb, $4, $5)`,
          [foreign, T_BETA, randomUUID(), 'b'.repeat(64), USER_A1],
        );
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      const crafted = structuredClone(doc);
      const sub = crafted.tables.rcm_claim_submissions?.[0] as Record<string, unknown>;
      sub.validation_id = foreign;
      await expect(importBillingExport(fresh.admin, T_ALPHA, crafted)).rejects.toThrow(/another tenant/);
      expect(await alphaEntries()).toBe(0);
    });

    it('a tampered amount that unbalances an entry fails the ledger re-verification and rolls back', async () => {
      const doc = await exportOf(r.h);
      const crafted = structuredClone(doc);
      const line = crafted.tables.billing_journal_lines?.[0] as {
        amount_minor: { currency: string; minor: number };
      };
      line.amount_minor = { ...line.amount_minor, minor: line.amount_minor.minor + 1 };
      await expect(importBillingExport(fresh.admin, T_ALPHA, crafted)).rejects.toThrow(/journal invariant/);
      expect(await alphaEntries()).toBe(0);
    });

    it('a self-approved write-off decision breaks a trigger invariant the replica import skips and rolls back', async () => {
      const doc = await exportOf(r.h);
      const crafted = structuredClone(doc);
      const res = crafted.tables.rcm_remittance_line_resolutions?.[0] as Record<string, unknown>;
      expect(res.action).toBe('write_off');
      const decision = crafted.tables.rcm_remittance_resolution_decisions?.[0] as Record<string, unknown>;
      decision.decided_by = res.requested_by;
      await expect(importBillingExport(fresh.admin, T_ALPHA, crafted)).rejects.toThrow(
        /other than its requester/,
      );
      expect(await alphaEntries()).toBe(0);
    });

    it('a Money amount in another currency than the tenant’s is refused and rolls back', async () => {
      const doc = await exportOf(r.h);
      const crafted = structuredClone(doc);
      const line = crafted.tables.billing_journal_lines?.[0] as {
        amount_minor: { currency: string; minor: number };
      };
      line.amount_minor = { ...line.amount_minor, currency: 'EUR' };
      await expect(importBillingExport(fresh.admin, T_ALPHA, crafted)).rejects.toThrow(/currency/);
      expect(await alphaEntries()).toBe(0);
    });

    it('a reference to a missing row fails the foreign-key validation and rolls back', async () => {
      const doc = await exportOf(r.h);
      const crafted = structuredClone(doc);
      const claim = crafted.tables.rcm_claims?.[0] as Record<string, unknown>;
      claim.coverage_id = randomUUID();
      await expect(importBillingExport(fresh.admin, T_ALPHA, crafted)).rejects.toThrow(/foreign key/);
      expect(await alphaEntries()).toBe(0);
    });
  });
});
