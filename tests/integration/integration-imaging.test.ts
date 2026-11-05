import { randomUUID } from 'node:crypto';
import type { ImagingBlobBundle } from '@cuspatlas/contracts';
import {
  createMembershipSource,
  createSecurityAttemptSink,
  createTenantTransactionRunner,
  importExports,
  importImagingBlobs,
} from '@cuspatlas/db';
import {
  createAuthorize,
  createBillingService,
  createFakeClearinghouse,
  createImagingAttachmentRefResolver,
  createImagingImageRefResolver,
  verifyImportedNoteDigests,
} from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BILLING_ALL, seedBillingScopes, usd } from './support/billing-fixtures';
import { seedClinicalScopes } from './support/clinical-fixtures';
import { actorFor } from './support/domain-harness';
import { seedEngagementScopes } from './support/engagement-fixtures';
import { ctxFor, T_ALPHA, T_BETA, USER_A1, USER_B1 } from './support/fixtures';
import { type ImagingStack, ingestVia, pngBytes, startImagingStack } from './support/imaging-fixtures';
import {
  intakeBody,
  legacyPackage,
  PRACTICE,
  SOURCE_SYSTEM,
  seedMigrationScopes,
} from './support/migration-fixtures';
import { patientBody } from './support/patient-fixtures';
import { today } from './support/rcm-fixtures';
import { seedSchedulingScopes } from './support/scheduling-fixtures';

/**
 * Integration seams to I3 (synthetic data only): C15 encounter image links and E5 message attachments
 * read I3's consumer reference read (`imageReference`, expected patient required) through the real
 * resolvers the API and MCP builders wire; another tenant's reference is `not_found` / not attachable.
 * Then one combined S17 + I9 + C18 + E9 + B10 round trip into a fresh database and object store, with
 * a procedure -> charge -> claim -> remittance -> payment chain in the B document.
 */
type Doc = { format: string; exportedAt: string; tables: Record<string, Record<string, unknown>[]> };
let src: ImagingStack;
let dst: ImagingStack;
let p1: string;
let p2: string;
let img1: { objectRef: string; imageRef: string };
let img2: { objectRef: string; imageRef: string };
const LOC = 'loc-integration-imaging';
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;

async function associated(s: ImagingStack, patientRef: string, seed: number) {
  const a = await ingestVia(s, pngBytes(seed, 8, 8), { intendedPatientRef: patientRef });
  const c = await s.command('owner', `/v1/imaging/objects/${a.objectRef}/association`, {
    patientRef,
    basis: 'operatorSelected',
  });
  expect(c.status).toBe(201);
  return { objectRef: a.objectRef, imageRef: data<{ imageRef: string }>(c).imageRef };
}

beforeAll(async () => {
  src = await startImagingStack('integration_imaging_src');
  await seedSchedulingScopes(src.db.admin);
  await seedClinicalScopes(src.db.admin);
  await seedEngagementScopes(src.db.admin);
  await seedBillingScopes(src.db.admin);
  const mk = async (name: string) =>
    data<{ patientRef: string }>(await src.command('owner', '/v1/patients', patientBody(name))).patientRef;
  p1 = await mk('Integration Imaging One');
  p2 = await mk('Integration Imaging Two');
  expect(
    (
      await src.command('owner', '/v1/scheduling/locations', {
        locationRef: LOC,
        displayLabel: 'Synthetic integration imaging',
        timeZone: 'America/New_York',
      })
    ).status,
  ).toBe(201);
  img1 = await associated(src, p1, 9101);
  img2 = await associated(src, p2, 9102);
}, 180_000);

afterAll(async () => {
  await src?.close();
  await dst?.close();
});

async function encounter(s: ImagingStack, patientRef: string) {
  const r = await s.command('owner', '/v1/clinical/encounters', { patientRef, locationRef: LOC });
  expect(r.status).toBe(201);
  return data<{ encounter: { encounterRef: string } }>(r).encounter.encounterRef;
}

describe('C15 and E5 read I3 through the wired resolvers', () => {
  it('C15: an encounter links its own patient`s current imageRef; another patient`s is a mismatch; a made-up one is 404', async () => {
    const e = await encounter(src, p1);
    const ok = await src.command('owner', `/v1/clinical/encounters/${e}/image-links`, {
      imageRef: img1.imageRef,
    });
    expect(ok.status).toBe(201);
    const link = data<{ imageLinkRef: string; imageResolution?: string }>(ok);
    const read = data<Record<string, unknown>>(
      await src.inject('owner', 'GET', `/v1/clinical/image-links/${link.imageLinkRef}`),
    );
    expect(JSON.stringify(read)).toContain('"current"');
    const other = await src.command('owner', `/v1/clinical/encounters/${e}/image-links`, {
      imageRef: img2.imageRef,
    });
    expect([other.status, (other.json.detail as { reason?: string })?.reason]).toStrictEqual([
      409,
      'image_patient_mismatch',
    ]);
    const missing = await src.command('owner', `/v1/clinical/encounters/${e}/image-links`, {
      imageRef: randomUUID(),
    });
    expect(missing.status).toBe(404);
  });

  it('another tenant`s imageRef is not_found and never attachable (tenant transaction, RLS)', async () => {
    const beta = await actorFor(src.db, USER_B1, T_BETA);
    const run = createTenantTransactionRunner(src.db.app);
    const images = createImagingImageRefResolver();
    const attachments = createImagingAttachmentRefResolver();
    const seen = await run(beta, async (tx) => ({
      image: await images.resolve(tx, img1.imageRef, p1),
      byImageRef: await attachments.belongsToPatient(tx, p1, { kind: 'imageRef', ref: img1.imageRef }),
      byObjectRef: await attachments.belongsToPatient(tx, p1, { kind: 'objectRef', ref: img1.objectRef }),
    }));
    expect(seen).toStrictEqual({ image: { status: 'not_found' }, byImageRef: false, byObjectRef: false });
  });

  it('E5: a staff message attaches its own patient`s image (by imageRef or objectRef) and refuses another`s', async () => {
    const open = (patientRef: string, attachment: { kind: string; ref: string }) =>
      src.command('owner', `/v1/patients/${patientRef}/message-threads`, {
        topic: 'general',
        locationRef: LOC,
        body: 'Synthetic integration message',
        attachments: [attachment],
      });
    expect((await open(p1, { kind: 'imageRef', ref: img1.imageRef })).status).toBe(201);
    expect((await open(p1, { kind: 'objectRef', ref: img1.objectRef })).status).toBe(201);
    const foreign = await open(p1, { kind: 'imageRef', ref: img2.imageRef });
    expect(foreign.status).not.toBe(201);
    expect([400, 404, 409, 422]).toContain(foreign.status);
  });
});

/** B chain on the source: procedure -> charge -> claim -> remittance (settled) -> payment (allocated). */
async function seedBillingChain(s: ImagingStack, patientRef: string): Promise<void> {
  const ok = <T>(r: { status: number; json: Record<string, unknown> }, status = 201) => {
    expect([r.status, r.json]).toMatchObject([status, {}]);
    return data<T>(r);
  };
  const fake = createFakeClearinghouse();
  const svc = createBillingService({
    authorize: createAuthorize(createMembershipSource(s.db.app)),
    withTenantTransaction: createTenantTransactionRunner(s.db.app),
    recording: { sink: createSecurityAttemptSink(s.db.sink), alert: () => {} },
    claims: fake,
  });
  const a1 = ctxFor(T_ALPHA, USER_A1, 'human', [...BILLING_ALL, 'patients.read', 'patients.write']);
  const env = (operation: string, payload: unknown) => ({ operation, idempotencyKey: randomUUID(), payload });
  ok(
    await s.command('owner', '/v1/billing/fee-schedules/versions', {
      scheduleRef: 'syn-fee-five-way',
      purpose: 'practice',
      effectiveFrom: '2026-01-01',
      items: [{ codeRef: 'SYN-5W-100', fee: usd(20000) }],
    }),
  );
  const provider = ok<{ resourceRef: string }>(
    await s.command('owner', '/v1/scheduling/resources', {
      kind: 'provider',
      locationRef: LOC,
      displayLabel: 'Synthetic five-way provider',
    }),
  ).resourceRef;
  const coverageRef = ok<{ coverageRef: string }>(
    await s.command('owner', '/v1/rcm/coverages', {
      patientRef,
      payerRef: 'syn-payer-five-way',
      rank: 'primary',
      relationshipToSubscriber: 'self',
      memberRef: 'syn-member-five-way-1',
      effectiveFrom: '2026-01-01',
    }),
  ).coverageRef;
  ok(
    await s.command('owner', `/v1/rcm/coverages/${coverageRef}/eligibility`, {
      source: 'fake_adapter',
      serviceDate: today(),
    }),
  );
  const enc = ok<{ encounter: { encounterRef: string; version: number } }>(
    await s.command('owner', '/v1/clinical/encounters', { patientRef, locationRef: LOC }),
  ).encounter;
  ok(
    await s.command('owner', `/v1/clinical/encounters/${enc.encounterRef}/assignments`, {
      expectedVersion: enc.version,
      role: 'treating_provider',
      assignee: { kind: 'provider', resourceRef: provider },
    }),
  );
  const proc = ok<{ procedureRef: string }>(
    await s.command('owner', `/v1/clinical/encounters/${enc.encounterRef}/procedures`, {
      sequence: 1,
      dateOfService: today(),
      renderingProviderRef: provider,
      codeRef: 'SYN-5W-100',
    }),
  ).procedureRef;
  const consumed = await s.inject('service', 'POST', `/v1/billing/procedure-events/${proc}/consume`, {});
  expect([200, 201]).toContain(consumed.status);
  const chargeRef = data<{ chargeRef: string }>(consumed).chargeRef;
  const claimRef = (
    await svc.prepareClaim(a1, env('rcm.claims.prepare', { patientRef, coverageRef, procedureRefs: [proc] }))
  ).data.claimRef;
  await svc.validateClaim(a1, claimRef, env('rcm.claims.validate', { expectedVersion: 1 }));
  await svc.submitClaim(
    a1,
    claimRef,
    env('rcm.claims.submit', { expectedVersion: 2, authorization: { mode: 'explicit' } }),
  );
  await svc.pollClaim(a1, claimRef);
  const eraRef = `syn-era-five-way-${Date.now().toString(36)}`;
  fake.stageRemittance({
    remittanceRef: eraRef,
    payerRef: 'syn-payer-five-way',
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
  const rem = (await svc.ingestRemittance(a1, env('rcm.remittances.ingest', { remittanceRef: eraRef }))).data;
  await svc.settleRemittance(
    a1,
    rem.remittanceRef,
    env('rcm.remittances.settle', { settlementRef: 'syn-eft-five-way-1', amount: usd(15000) }),
  );
  const paymentRef = ok<{ paymentRef: string }>(
    await s.command('owner', '/v1/billing/payments', { patientRef, amount: usd(2000), method: 'cash' }),
  ).paymentRef;
  ok(
    await s.command('owner', `/v1/billing/payments/${paymentRef}/allocations`, {
      allocations: [{ chargeRef, amount: usd(2000) }],
    }),
  );
}

describe('S17 + I9 + C18 + E9 + B10 combined round trip', () => {
  it('imports all five documents and the blobs in one order into a fresh database and store and exports identically; a tampered B document rolls the whole import back', {
    timeout: 300_000,
  }, async () => {
    await seedBillingChain(src, p1);
    // H2 M-9: a migrated opening balance and unapplied credit travel with B (the opening chain).
    await seedMigrationScopes(src.db.admin);
    const profileRef = data<{ profileRef: string }>(
      await src.command('owner', '/v1/migration/source-profiles', {
        sourceSystem: SOURCE_SYSTEM,
        format: 'cuspatlas-synthetic-legacy/1',
        practiceRef: PRACTICE,
      }),
    ).profileRef;
    const packageRef = data<{ packageRef: string }>(
      await src.command(
        'owner',
        '/v1/migration/packages',
        intakeBody(
          profileRef,
          legacyPackage({
            patients:
              'patient_id,last_name,first_name,birth_date,phone,guarantor_id\nQ001,Opening,Rowe,1972-02-02,5551000001,G1\n',
            ledger_balances:
              'balance_id,account_id,patient_id,balance_minor,currency,as_of\nQB1,G1,Q001,4200,USD,2026-10-31\n',
            unapplied_credits:
              'payment_id,account_id,patient_id,amount_minor,currency,received_on\nQC1,G1,Q001,900,USD,2026-09-01\n',
          }),
        ),
      ),
    ).packageRef;
    const planDigest = data<{ planDigest: string }>(
      await src.inject('owner', 'GET', `/v1/migration/imports/plan?packageRef=${packageRef}`),
    ).planDigest;
    expect(
      data<{ state: string }>(
        await src.command('owner', '/v1/migration/imports/apply', {
          packageRef,
          expectedPlanDigest: planDigest,
          batchSize: 50,
        }),
      ).state,
    ).toBe('complete');
    const exportOf = async (s: ImagingStack, path: string) => {
      const r = await s.inject('owner', 'GET', path);
      expect([path, r.status]).toStrictEqual([path, 200]);
      return data<Doc>(r);
    };
    const paths = [
      '/v1/scheduling/export',
      '/v1/imaging/export',
      '/v1/clinical/export',
      '/v1/communications/export',
      '/v1/billing/export',
    ];
    const docs = await Promise.all(paths.map((p) => exportOf(src, p)));
    const bundles: ImagingBlobBundle[] = [];
    let after: string | null = '';
    while (after !== null) {
      const r = await src.inject('owner', 'GET', `/v1/imaging/export/blobs${after ? `?after=${after}` : ''}`);
      const page = data<ImagingBlobBundle & { next: string | null }>(r);
      bundles.push(page);
      after = page.next;
    }
    expect(docs[2]?.tables.clinical_encounter_image_links?.length).toBeGreaterThan(0);
    expect(docs[3]?.tables.thread_messages?.length).toBeGreaterThan(0);
    expect(docs[4]?.tables.migration_opening_items?.length).toBe(2);
    expect(docs[4]?.tables.migration_staged_records?.length).toBe(2);
    for (const t of ['billing_journal_entries', 'rcm_claims', 'rcm_remittances', 'billing_payments']) {
      expect([t, (docs[4]?.tables[t]?.length ?? 0) > 0]).toStrictEqual([t, true]);
    }
    dst = await startImagingStack('integration_imaging_dst');
    // Tenancy is A's (exported by none of these): the target members get the source scopes.
    for (const m of (
      await src.db.admin.query('SELECT tenant_id, principal_id, scopes FROM cuspatlas.memberships')
    ).rows) {
      await dst.db.admin.query(
        'UPDATE cuspatlas.memberships SET scopes = $3 WHERE tenant_id = $1 AND principal_id = $2',
        [m.tenant_id, m.principal_id, m.scopes],
      );
    }
    // A tampered B document (an unbalanced journal line) fails the ledger check and rolls S, I, C, E back too.
    const b = docs[4] as Doc;
    const lines = b.tables.billing_journal_lines ?? [];
    const firstLine = lines[0] as { amount_minor: { currency: string; minor: number } };
    const tampered = {
      ...b,
      tables: {
        ...b.tables,
        billing_journal_lines: [
          {
            ...firstLine,
            amount_minor: { ...firstLine.amount_minor, minor: firstLine.amount_minor.minor + 1 },
          },
          ...lines.slice(1),
        ],
      },
    };
    await expect(
      importExports(dst.db.admin, T_ALPHA, [...docs.slice(0, 4), tampered] as never, {
        verifyNoteDigests: verifyImportedNoteDigests,
      }),
    ).rejects.toThrow(/journal invariant/);
    const leftover = await dst.db.admin.query(
      `SELECT (SELECT count(*) FROM cuspatlas.patients WHERE id = $1)::int AS p,
              (SELECT count(*) FROM cuspatlas.billing_journal_entries)::int AS j`,
      [p1],
    );
    expect(leftover.rows[0]).toStrictEqual({ p: 0, j: 0 });
    // Given in reverse order; loaded S, I, C, E, B.
    const counts = await importExports(dst.db.admin, T_ALPHA, [...docs].reverse() as never, {
      verifyNoteDigests: verifyImportedNoteDigests,
    });
    expect(counts.imaging_image_refs).toBe(docs[1]?.tables.imaging_image_refs?.length);
    expect(counts.clinical_encounter_image_links).toBe(
      docs[2]?.tables.clinical_encounter_image_links?.length,
    );
    expect(counts.verifiedEntries).toBe(docs[4]?.tables.billing_journal_entries?.length);
    await importImagingBlobs(dst.store, T_ALPHA, docs[1] as never, bundles);
    for (const [i, p] of paths.entries()) {
      const again = await exportOf(dst, p);
      expect([p, { ...again, exportedAt: null }]).toStrictEqual([p, { ...docs[i], exportedAt: null }]);
    }
    // The imported link still resolves through I3 in the target.
    const link = docs[2]?.tables.clinical_encounter_image_links?.[0]?.id as string;
    const read = data<Record<string, unknown>>(
      await dst.inject('owner', 'GET', `/v1/clinical/image-links/${link}`),
    );
    expect(JSON.stringify(read)).toContain('"current"');
  });
});
