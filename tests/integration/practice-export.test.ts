import type { ImagingBlobBundle } from '@cuspatlas/contracts';
import { importExports, importImagingBlobs } from '@cuspatlas/db';
import { PRACTICE_EXPORT_FORMAT, validatePracticeExport, verifyImportedNoteDigests } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedBillingScopes } from './support/billing-fixtures';
import { seedClinicalScopes } from './support/clinical-fixtures';
import { seedEngagementScopes } from './support/engagement-fixtures';
import { T_ALPHA } from './support/fixtures';
import { type ImagingStack, ingestVia, pngBytes, startImagingStack } from './support/imaging-fixtures';
import {
  intakeBody,
  legacyPackage,
  PRACTICE,
  SOURCE_SYSTEM,
  seedMigrationScopes,
} from './support/migration-fixtures';
import { patientBody } from './support/patient-fixtures';
import { seedSchedulingScopes } from './support/scheduling-fixtures';

/**
 * M1 practice export contract (synthetic only; M-S1 blocks a real incumbent export). One versioned
 * manifest over the S, I, C, E and B documents (B carries the migration opening chain), per-document
 * digests, per-table counts, blob digests and terminology refs, no tenant identifier; a completeness
 * validator; human-only elevated creation, private short-lived delivery through a grant; a round trip
 * into a fresh database and store through `importExports`.
 */
type Doc = { format: string; exportedAt: string; tables: Record<string, Record<string, unknown>[]> };
type Manifest = {
  format: string;
  exportedAt: string;
  documents: { format: string; digestSha256: string; tables: Record<string, number> }[];
  blobs: { digestSha256: string; byteLength: number }[];
  terminology: { system: string; licensed: boolean };
};
type Pkg = { manifest: Manifest; documents: Doc[] };
let src: ImagingStack;
let dst: ImagingStack;
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;

async function seed(s: ImagingStack) {
  await seedSchedulingScopes(s.db.admin);
  await seedClinicalScopes(s.db.admin);
  await seedEngagementScopes(s.db.admin);
  await seedBillingScopes(s.db.admin);
  await seedMigrationScopes(s.db.admin);
}

/** Replaces one table of the first document (the S export) in a copy of the package. */
function withTable(pkg: Pkg, table: string, rows: Record<string, unknown>[] | undefined): Pkg {
  const [s, ...rest] = pkg.documents as [Doc, ...Doc[]];
  const tables = { ...s.tables };
  if (rows === undefined) delete tables[table];
  else tables[table] = rows;
  return { ...pkg, documents: [{ ...s, tables }, ...rest] };
}

beforeAll(async () => {
  src = await startImagingStack('practice_export_src');
  await seed(src);
  const p = data<{ patientRef: string }>(
    await src.command('owner', '/v1/patients', patientBody('Practice Export One')),
  ).patientRef;
  const a = await ingestVia(src, pngBytes(9301, 8, 8), { intendedPatientRef: p });
  expect(
    (
      await src.command('owner', `/v1/imaging/objects/${a.objectRef}/association`, {
        patientRef: p,
        basis: 'operatorSelected',
      })
    ).status,
  ).toBe(201);
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
            'patient_id,last_name,first_name,birth_date,phone,guarantor_id\nX001,Exit,Rowe,1971-03-03,5551000002,G1\n',
          ledger_balances:
            'balance_id,account_id,patient_id,balance_minor,currency,as_of\nXB1,G1,X001,3100,USD,2026-10-31\n',
        }),
      ),
    ),
  ).packageRef;
  const planDigest = data<{ planDigest: string }>(
    await src.inject('owner', 'GET', `/v1/migration/imports/plan?packageRef=${packageRef}`),
  ).planDigest;
  expect(
    (
      await src.command('owner', '/v1/migration/imports/apply', {
        packageRef,
        expectedPlanDigest: planDigest,
        batchSize: 50,
      })
    ).status,
  ).toBe(200);
}, 240_000);

afterAll(async () => {
  await src?.close();
  await dst?.close();
});

async function createExport(s: ImagingStack) {
  const r = await s.command('owner', '/v1/practice/exports', { purpose: 'practiceExit' });
  expect([r.status, r.body.slice(0, 300)]).toStrictEqual([201, r.body.slice(0, 300)]);
  return data<{ exportRef: string; manifestDigest: string; format: string; documentCount: number }>(r);
}

async function download(s: ImagingStack, exportRef: string): Promise<Pkg> {
  const g = await s.command('owner', '/v1/practice/exports/grants', { exportRef });
  expect(g.status).toBe(201);
  const { token, expiresAt } = data<{ token: string; expiresAt: string }>(g);
  expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
  const r = await s.command('owner', '/v1/practice/exports/package', { exportRef, token });
  expect(r.status).toBe(200);
  return data<Pkg>(r);
}

describe('M1 practice export', () => {
  let exportRef: string;
  let pkg: Pkg;

  it('creates one versioned, tenant-free manifest over S, I, C, E and B with digests and counts', async () => {
    const created = await createExport(src);
    exportRef = created.exportRef;
    expect(created.format).toBe(PRACTICE_EXPORT_FORMAT);
    expect(created.documentCount).toBe(5);
    pkg = await download(src, exportRef);
    const m = pkg.manifest;
    expect(m.format).toBe('cuspatlas-practice-export/1');
    expect(m.documents.map((d) => d.format)).toStrictEqual(pkg.documents.map((d) => d.format));
    expect(m.documents).toHaveLength(5);
    for (const [i, d] of m.documents.entries()) {
      for (const [t, n] of Object.entries(d.tables)) {
        expect([t, n]).toStrictEqual([t, pkg.documents[i]?.tables[t]?.length]);
      }
    }
    const b = pkg.documents.find((d) => d.format.startsWith('cuspatlas-billing'));
    expect(b?.tables.migration_opening_items?.length).toBe(1);
    expect(m.blobs.length).toBe(1);
    expect(m.terminology.licensed).toBe(false);
    expect(JSON.stringify(pkg)).not.toContain(T_ALPHA);
    expect(validatePracticeExport(pkg)).toStrictEqual({ accepted: true, warnings: [] });
    const v = await src.inject('owner', 'GET', `/v1/practice/exports/verification?exportRef=${exportRef}`);
    expect(data<{ state: string; mismatches: unknown[] }>(v)).toMatchObject({
      state: 'verified',
      mismatches: [],
    });
  });

  it('the completeness validator refuses every partial or inconsistent package, naming the entity', () => {
    const s = pkg.documents[0] as Doc;
    const t = Object.keys(s.tables).find((k) => (s.tables[k]?.length ?? 0) > 0) as string;
    const rows = s.tables[t] ?? [];
    const row0 = rows[0] as Record<string, unknown>;
    expect(validatePracticeExport(withTable(pkg, t, rows.slice(1)))).toMatchObject({
      accepted: false,
      reason: 'count_mismatch',
      entity: `${s.format}:${t}`,
    });
    expect(
      validatePracticeExport(withTable(pkg, t, [{ ...row0, version: 99 }, ...rows.slice(1)])),
    ).toMatchObject({ accepted: false, reason: 'digest_mismatch', entity: s.format });
    expect(
      validatePracticeExport({ manifest: pkg.manifest, documents: pkg.documents.slice(0, 4) }),
    ).toMatchObject({
      accepted: false,
      reason: 'missing_entity',
    });
    expect(validatePracticeExport(withTable(pkg, t, undefined))).toMatchObject({
      accepted: false,
      reason: 'missing_entity',
      entity: `${s.format}:${t}`,
    });
    expect(
      validatePracticeExport({
        ...pkg,
        manifest: { ...pkg.manifest, format: 'cuspatlas-practice-export/2' },
      }),
    ).toMatchObject({ accepted: false, reason: 'unknown_version' });
    expect(
      validatePracticeExport({ manifest: { ...pkg.manifest, documents: [] }, documents: [] }),
    ).toMatchObject({
      accepted: false,
      reason: 'empty_manifest',
    });
    expect(
      validatePracticeExport(withTable(pkg, t, [{ ...row0, tenant_id: T_ALPHA }, ...rows.slice(1)])),
    ).toMatchObject({ accepted: false, reason: 'tenant_mismatch' });
    expect(validatePracticeExport({ ...pkg, manifest: { ...pkg.manifest, blobs: [] } })).toMatchObject({
      accepted: false,
      reason: 'count_mismatch',
      entity: 'blobs',
    });
  });

  it('is human-only and elevated; delivery is bound to the grant holder and refused without a live grant', async () => {
    for (const who of ['imagingReadOnly', 'service'] as const) {
      const r = await src.command(who, '/v1/practice/exports', { purpose: 'practiceExit' });
      expect([who, r.status]).toStrictEqual([who, 403]);
    }
    const g = data<{ token: string }>(
      await src.command('owner', '/v1/practice/exports/grants', { exportRef }),
    );
    const other = await src.command('writer', '/v1/practice/exports/package', { exportRef, token: g.token });
    expect(other.status).toBe(403);
    const forged = await src.command('owner', '/v1/practice/exports/package', {
      exportRef,
      token: `${g.token.slice(0, -2)}AA`,
    });
    expect(forged.status).toBe(404);
    expect(forged.body).not.toContain(exportRef);
    const mcp = await src.mcp('owner', 'practice_export_download', {
      exportRef,
      token: 'v1.x',
      idempotencyKey: 'k-mcp-forged',
    });
    expect(mcp.isError).toBe(true);
    const audit = await src.db.admin.query(
      `SELECT count(*)::int AS n FROM cuspatlas.sensitive_read_events WHERE operation = 'practice.export.download'`,
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('round-trips into a fresh database and store through importExports and re-exports the same manifest', {
    timeout: 300_000,
  }, async () => {
    dst = await startImagingStack('practice_export_dst');
    // Tenancy is A's (exported by none of these): the target members get the source scopes.
    for (const m of (
      await src.db.admin.query('SELECT tenant_id, principal_id, scopes FROM cuspatlas.memberships')
    ).rows) {
      await dst.db.admin.query(
        'UPDATE cuspatlas.memberships SET scopes = $3 WHERE tenant_id = $1 AND principal_id = $2',
        [m.tenant_id, m.principal_id, m.scopes],
      );
    }
    await importExports(dst.db.admin, T_ALPHA, pkg.documents as never, {
      verifyNoteDigests: verifyImportedNoteDigests,
    });
    const bundles: ImagingBlobBundle[] = [];
    let after: string | null = '';
    while (after !== null) {
      const r = await src.inject('owner', 'GET', `/v1/imaging/export/blobs${after ? `?after=${after}` : ''}`);
      const page = data<ImagingBlobBundle & { next: string | null }>(r);
      bundles.push(page);
      after = page.next;
    }
    const imaging = pkg.documents.find((d) => d.format.startsWith('cuspatlas-imaging'));
    await importImagingBlobs(dst.store, T_ALPHA, imaging as never, bundles);
    const again = await download(dst, (await createExport(dst)).exportRef);
    const strip = (m: Manifest) => ({ ...m, exportedAt: null, exportRef: null });
    expect(strip(again.manifest)).toStrictEqual(strip(pkg.manifest));
  });

  it('verification reports drift against the live tenant, naming the table', async () => {
    expect((await src.command('owner', '/v1/patients', patientBody('Practice Export Later'))).status).toBe(
      201,
    );
    const v = await src.inject('owner', 'GET', `/v1/practice/exports/verification?exportRef=${exportRef}`);
    const body = data<{ state: string; mismatches: { entity: string; reason: string }[] }>(v);
    expect(body.state).toBe('drifted');
    expect(body.mismatches).toContainEqual(
      expect.objectContaining({ reason: 'count_mismatch', entity: expect.stringMatching(/:patients$/) }),
    );
  });
});
