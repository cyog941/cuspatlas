import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MIGRATION_OPS } from '@cuspatlas/api';
import { MIGRATION_EXPORT_FORMAT } from '@cuspatlas/contracts';
import { importExports } from '@cuspatlas/db';
import { verifyImportedNoteDigests } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T_ALPHA, USER_A1, USER_A4 } from './support/fixtures';
import { type ImagingStack, startImagingStack } from './support/imaging-fixtures';
import { MIGRATION_HARNESS_ROWS } from './support/migration-harness';
import { seedSyntheticPractice } from './support/practice-fixtures';

/**
 * M10 migration parity, negative matrix and migration export (synthetic only).
 * - Parity matrix derived from the operation catalog: every workstream M operation has its REST
 *   route, its MCP tool (registered on the server) and a negative-matrix row; a missing one fails.
 * - Negative matrix for the M batch 2 operations (M1, M7, M9, M10): cross-tenant, revoked membership,
 *   downgraded role (the op's own scope removed after the token was issued) and MCP, each refused
 *   with no state change and no alpha reference in the response. The M2-M6 operations are covered by
 *   the shared negative harness (MIGRATION_HARNESS_ROWS).
 * - Migration export round trip: S, I, C, E, B and the migration workspace import into a fresh
 *   database and re-export identically.
 */
type Who = 'owner' | 'crossTenant' | 'revoked';
interface Row {
  readonly operation: string;
  readonly crossTenant: 'not_found' | 'own_tenant';
  call(f: Record<string, string>): { method: 'GET' | 'POST'; url: string; body?: Record<string, unknown> };
}
const OPERATION_CATALOG: readonly {
  operation: string;
  owner: string;
  scope: string;
  mcpTool?: string;
  rest?: { path: string };
}[] = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../packages/contracts/src/catalog/operations.json'), 'utf8'),
);
const data = <T>(r: { json: Record<string, unknown> }) => r.json.data as T;
let s: ImagingStack;
let dst: ImagingStack | undefined;
const f: Record<string, string> = {};

const get = (url: string) => ({ method: 'GET' as const, url });
const post = (url: string, body: Record<string, unknown>) => ({ method: 'POST' as const, url, body });
const placeholderProfile = {
  operatorRef: 'placeholder:matrix-operator',
  hostingModel: 'contracted',
  responsibilities: ['backup', 'restore_drill', 'security_incident', 'support', 'escalation'].map((r) => ({
    responsibility: r,
    roleName: 'placeholder:matrix-role',
    contactRef: 'placeholder:matrix-desk',
  })),
  escalation: [
    {
      incidentClass: 'security_incident',
      responderClass: 'operator',
      coverage: 'always',
      expectedFirstResponseMinutes: 60,
    },
  ],
};

export const BATCH2_ROWS: Row[] = [
  {
    operation: 'practice.export.create',
    crossTenant: 'own_tenant',
    call: () => post('/v1/practice/exports', { purpose: 'verification' }),
  },
  {
    operation: 'practice.export.grant',
    crossTenant: 'not_found',
    call: (x) => post('/v1/practice/exports/grants', { exportRef: x.exportRef as string }),
  },
  {
    operation: 'practice.export.download',
    crossTenant: 'not_found',
    call: (x) =>
      post('/v1/practice/exports/package', { exportRef: x.exportRef as string, token: x.token as string }),
  },
  {
    operation: 'practice.export.verify',
    crossTenant: 'not_found',
    call: (x) => get(`/v1/practice/exports/verification?exportRef=${x.exportRef}`),
  },
  {
    operation: 'migration.archive.register',
    crossTenant: 'not_found',
    call: (x) => post('/v1/migration/archives', { packageRef: x.packageRef as string }),
  },
  {
    operation: 'migration.archive.verify',
    crossTenant: 'not_found',
    call: (x) => post('/v1/migration/archives/verify', { archiveRef: x.archiveRef as string }),
  },
  {
    operation: 'migration.archive.references',
    crossTenant: 'not_found',
    call: (x) => get(`/v1/migration/archives/references?patientRef=${x.archivePatient}`),
  },
  {
    operation: 'migration.archive.read',
    crossTenant: 'not_found',
    call: (x) => get(`/v1/migration/archives/entries?entryRef=${x.entryRef}&patientRef=${x.archivePatient}`),
  },
  {
    operation: 'migration.archive.holds.record',
    crossTenant: 'not_found',
    call: (x) =>
      post('/v1/migration/archives/holds', {
        archiveRef: x.archiveRef as string,
        action: 'place',
        reasonCode: 'litigation',
      }),
  },
  {
    operation: 'migration.archive.retention.evaluate',
    crossTenant: 'not_found',
    call: (x) => get(`/v1/migration/archives/retention?archiveRef=${x.archiveRef}`),
  },
  {
    operation: 'operations.operatorProfiles.record',
    crossTenant: 'own_tenant',
    call: () => post('/v1/operations/operator-profiles', placeholderProfile),
  },
  {
    operation: 'operations.backupVerifications.record',
    crossTenant: 'own_tenant',
    call: () =>
      post('/v1/operations/backup-verifications', {
        backupDigest: 'b'.repeat(64),
        manifestVerified: true,
        isolatedRestore: 'not_run',
      }),
  },
  {
    operation: 'operations.readiness.assert',
    crossTenant: 'own_tenant',
    call: () => get('/v1/operations/readiness'),
  },
  {
    operation: 'operations.alerts.list',
    crossTenant: 'own_tenant',
    call: () => get('/v1/operations/alerts'),
  },
  {
    operation: 'operations.downtime.start',
    crossTenant: 'own_tenant',
    call: () =>
      post('/v1/operations/downtime/windows', {
        scope: 'locations',
        locationRefs: ['loc-matrix'],
        reasonCode: 'other',
      }),
  },
  {
    operation: 'operations.downtime.end',
    crossTenant: 'not_found',
    call: (x) =>
      post('/v1/operations/downtime/windows/end', {
        windowRef: x.downtimeWindow as string,
        expectedVersion: 1,
      }),
  },
  {
    operation: 'operations.downtime.log',
    crossTenant: 'not_found',
    call: (x) =>
      post('/v1/operations/downtime/entries', {
        windowRef: x.downtimeWindow as string,
        entryKind: 'other',
        summary: 'Synthetic matrix sheet',
        payload: [{ name: 'sheet', value: 'matrix' }],
        paperRef: 'MATRIX-2',
        capturedAt: x.downtimeCaptured as string,
      }),
  },
  {
    operation: 'operations.downtime.entries.resolve',
    crossTenant: 'not_found',
    call: (x) =>
      post('/v1/operations/downtime/entries/resolve', {
        entryRef: x.downtimeEntry as string,
        expectedVersion: 1,
        decision: 'rejected',
        rejectionReason: 'duplicate',
      }),
  },
  {
    operation: 'operations.downtime.entries.list',
    crossTenant: 'own_tenant',
    // Filtered by state, not by an alpha window ref: the envelope echoes the caller filters.
    call: () => get('/v1/operations/downtime/entries?reviewState=pending_review'),
  },
  {
    operation: 'operations.downtime.windows.list',
    crossTenant: 'own_tenant',
    call: () => get('/v1/operations/downtime/windows'),
  },
  // Closeout A6: a cross-tenant administrator's assignment of an alpha member is refused (422) with no
  // alpha state change; ending an alpha assignment is hidden (404).
  {
    operation: 'migration.reviewers.assign',
    crossTenant: 'own_tenant',
    call: () => post('/v1/migration/reviewers', { principalRef: USER_A4, role: 'financialReviewer' }),
  },
  {
    operation: 'migration.reviewers.unassign',
    crossTenant: 'not_found',
    call: (x) =>
      post('/v1/migration/reviewers/unassign', {
        assignmentRef: x.reviewerAssignment as string,
        expectedVersion: 1,
        reasonCode: 'role_change',
      }),
  },
  {
    operation: 'migration.reviewers.list',
    crossTenant: 'own_tenant',
    call: () => get('/v1/migration/reviewers'),
  },
  { operation: 'migration.export', crossTenant: 'own_tenant', call: () => get('/v1/migration/export') },
];

/** Catalog-derived parity gaps: an M operation without a route, an MCP tool or a negative row. */
export function parityGaps(
  catalog: readonly { operation: string; owner: string; mcpTool?: string; rest?: { path: string } }[],
  tools: readonly string[],
  rows: readonly string[],
): string[] {
  const gaps: string[] = [];
  for (const op of catalog.filter((o) => o.owner === 'M')) {
    const route = MIGRATION_OPS.find((r) => r.operationId === op.operation);
    if (!route || route.path !== op.rest?.path) gaps.push(`${op.operation}: rest`);
    if (!op.mcpTool || !tools.includes(op.mcpTool)) gaps.push(`${op.operation}: mcp`);
    if (!rows.includes(op.operation)) gaps.push(`${op.operation}: negative`);
  }
  return gaps;
}

const STATE_TABLES = [
  'practice_exports',
  'practice_export_grants',
  'migration_archive_packages',
  'migration_archive_entries',
  'migration_archive_holds',
  'ops_operator_profiles',
  'ops_backup_verifications',
  'ops_downtime_windows',
  'ops_downtime_entries',
  'migration_reviewer_assignments',
  'audit_events',
  'sensitive_read_events',
];
const state = async () =>
  (
    await s.db.admin.query(
      `SELECT ${STATE_TABLES.map((t) => `(SELECT count(*) FROM cuspatlas.${t} WHERE tenant_id = '${T_ALPHA}')::int AS ${t}`).join(', ')}`,
    )
  ).rows[0];

async function viaRest(who: Who, c: ReturnType<Row['call']>) {
  return c.method === 'GET' ? s.inject(who, 'GET', c.url) : s.command(who, c.url, c.body);
}
async function viaMcp(who: Who, op: string, c: ReturnType<Row['call']>) {
  const tool = MIGRATION_OPS.find((o) => o.operationId === op)?.tool as string;
  const args =
    c.method === 'GET'
      ? Object.fromEntries(new URL(c.url, 'http://x').searchParams.entries())
      : { ...c.body, idempotencyKey: randomUUID() };
  try {
    return await s.mcp(who, tool, args);
  } catch (err) {
    // A revoked membership is refused at the MCP transport (403 before any tool runs).
    const raw = String((err as Error).message);
    expect(raw).toMatch(/forbidden/);
    return { isError: true, body: {}, raw };
  }
}

beforeAll(async () => {
  s = await startImagingStack('migration_matrix');
  const seeded = await seedSyntheticPractice(s, 'Matrix');
  f.packageRef = seeded.packageRef;
  f.exportRef = data<{ exportRef: string }>(
    await s.command('owner', '/v1/practice/exports', { purpose: 'verification' }),
  ).exportRef;
  f.token = data<{ token: string }>(
    await s.command('owner', '/v1/practice/exports/grants', { exportRef: f.exportRef }),
  ).token;
  const archive = data<{ archiveRef: string }>(
    await s.command('owner', '/v1/migration/archives', { packageRef: f.packageRef }),
  );
  f.archiveRef = archive.archiveRef;
  const { rows } = await s.db.admin.query(
    'SELECT id, patient_id FROM cuspatlas.migration_archive_entries WHERE archive_id = $1 LIMIT 1',
    [f.archiveRef],
  );
  f.entryRef = rows[0].id;
  f.archivePatient = rows[0].patient_id;
  await s.command('owner', '/v1/operations/operator-profiles', placeholderProfile);
  // Closeout A2: one open downtime window over a matrix-only location with one pending entry.
  const started = new Date(Date.now() - 3_600_000).toISOString();
  f.downtimeCaptured = new Date(Date.now() - 1_800_000).toISOString();
  f.downtimeWindow = data<{ windowRef: string }>(
    await s.command('owner', '/v1/operations/downtime/windows', {
      scope: 'locations',
      locationRefs: ['loc-matrix'],
      reasonCode: 'network_outage',
      startedAt: started,
    }),
  ).windowRef;
  f.downtimeEntry = data<{ entryRef: string }>(
    await s.command('owner', '/v1/operations/downtime/entries', {
      windowRef: f.downtimeWindow,
      entryKind: 'other',
      summary: 'Synthetic matrix sheet',
      payload: [{ name: 'sheet', value: 'matrix' }],
      paperRef: 'MATRIX-1',
      capturedAt: f.downtimeCaptured,
    }),
  ).entryRef;
  // Closeout A6: one live reviewer assignment made by the administrator.
  f.reviewerAssignment = data<{ assignmentRef: string }>(
    await s.command('owner', '/v1/migration/reviewers', {
      principalRef: USER_A4,
      role: 'operationsReviewer',
    }),
  ).assignmentRef;
}, 300_000);

afterAll(async () => {
  await dst?.close();
  await s?.close();
});

describe('M10 parity matrix (derived from the operation catalog)', () => {
  it('every workstream M operation has its REST route, its MCP tool and a negative-matrix row', async () => {
    const tools = await s.mcpToolNames('owner');
    const rows = [...MIGRATION_HARNESS_ROWS.map((r) => r.operation), ...BATCH2_ROWS.map((r) => r.operation)];
    const catalog = OPERATION_CATALOG;
    expect(parityGaps(catalog, tools, rows)).toStrictEqual([]);
    const m = OPERATION_CATALOG.filter((o) => o.owner === 'M');
    expect(m.length).toBe(MIGRATION_OPS.length);
    // A missing tool fails the matrix.
    expect(
      parityGaps(
        catalog,
        tools.filter((t) => t !== 'practice_export_verify'),
        rows,
      ),
    ).toStrictEqual(['practice.export.verify: mcp']);
    expect(
      parityGaps(
        catalog,
        tools,
        rows.filter((r) => r !== 'migration.export'),
      ),
    ).toStrictEqual(['migration.export: negative']);
  });
});

describe('M10 negative matrix: M batch 2 operations', () => {
  const alphaRefs = () => Object.values(f).filter((v) => /^[0-9a-f-]{36}$/.test(v));

  it.each(BATCH2_ROWS.map((r) => [r.operation, r] as const))(
    '%s: revoked and cross-tenant, REST and MCP',
    async (_op, row) => {
      const c = row.call(f);
      for (const who of ['revoked', 'crossTenant'] as const) {
        const before = await state();
        const r = await viaRest(who, c);
        const m = await viaMcp(who, row.operation, c);
        if (who === 'revoked') {
          expect([row.operation, who, r.status]).toStrictEqual([row.operation, who, 403]);
          expect(m.isError).toBe(true);
        } else if (row.crossTenant === 'not_found') {
          expect([row.operation, who, r.status]).toStrictEqual([row.operation, who, 404]);
          expect(m.isError).toBe(true);
        }
        for (const raw of [r.body, m.raw]) for (const ref of alphaRefs()) expect(raw).not.toContain(ref);
        expect(await state()).toStrictEqual(before);
      }
    },
  );

  it.each(BATCH2_ROWS.map((r) => [r.operation, r] as const))(
    '%s: downgraded after the token was issued',
    async (_op, row) => {
      const scope = OPERATION_CATALOG.find((o) => o.operation === row.operation)?.scope as string;
      await s.db.admin.query(
        'UPDATE cuspatlas.memberships SET scopes = array_remove(scopes, $2) WHERE principal_id = $1',
        [USER_A1, scope],
      );
      try {
        const before = await state();
        const r = await viaRest('owner', row.call(f));
        const m = await viaMcp('owner', row.operation, row.call(f));
        expect([row.operation, r.status]).toStrictEqual([row.operation, 403]);
        expect(m.isError).toBe(true);
        expect(await state()).toStrictEqual(before);
      } finally {
        await s.db.admin.query(
          'UPDATE cuspatlas.memberships SET scopes = scopes || ARRAY[$2] WHERE principal_id = $1',
          [USER_A1, scope],
        );
      }
    },
  );

  it('no caller-supplied tenant is accepted by any batch 2 body', async () => {
    for (const row of BATCH2_ROWS) {
      const c = row.call(f);
      if (c.method !== 'POST') continue;
      const r = await s.command('owner', c.url, {
        ...c.body,
        tenantId: 'aaaaaaaa-0000-4000-8000-000000000000',
      });
      expect([row.operation, r.status]).toStrictEqual([row.operation, 400]);
    }
  });
});

describe('M10 migration export', () => {
  it('S, I, C, E, B and the migration workspace re-import into a fresh database without identifier loss', {
    timeout: 300_000,
  }, async () => {
    // A sign-off-free workspace still has runs, applied records, a report, an archive and ops rows.
    expect((await s.command('owner', '/v1/migration/reports', { packageRef: f.packageRef })).status).toBe(
      200,
    );
    const paths = [
      '/v1/scheduling/export',
      '/v1/imaging/export',
      '/v1/clinical/export',
      '/v1/communications/export',
      '/v1/billing/export',
      '/v1/migration/export',
    ];
    const exportOf = async (stack: ImagingStack, p: string) => {
      const r = await stack.inject('owner', 'GET', p);
      expect([p, r.status]).toStrictEqual([p, 200]);
      return data<{ format: string; exportedAt: string; tables: Record<string, unknown[]> }>(r);
    };
    const docs = [];
    for (const p of paths) docs.push(await exportOf(s, p));
    const m = docs[5] as { format: string; tables: Record<string, unknown[]> };
    expect(m.format).toBe(MIGRATION_EXPORT_FORMAT);
    for (const t of [
      'migration_applied_records',
      'migration_apply_runs',
      'migration_reports',
      'migration_archive_entries',
      'ops_operator_profiles',
      'ops_downtime_windows',
      'ops_downtime_entries',
    ]) {
      expect([t, (m.tables[t]?.length ?? 0) > 0]).toStrictEqual([t, true]);
    }
    expect(JSON.stringify(m)).not.toContain(T_ALPHA);
    dst = await startImagingStack('migration_matrix_dst');
    for (const row of (
      await s.db.admin.query('SELECT tenant_id, principal_id, scopes FROM cuspatlas.memberships')
    ).rows) {
      await dst.db.admin.query(
        'UPDATE cuspatlas.memberships SET scopes = $3 WHERE tenant_id = $1 AND principal_id = $2',
        [row.tenant_id, row.principal_id, row.scopes],
      );
    }
    const counts = await importExports(dst.db.admin, T_ALPHA, [...docs].reverse() as never, {
      verifyNoteDigests: verifyImportedNoteDigests,
    });
    expect(counts.migration_archive_entries).toBe(m.tables.migration_archive_entries?.length);
    for (const [i, p] of paths.entries()) {
      if (p === '/v1/imaging/export') continue; // blobs not copied here (M1 covers the byte round trip)
      const again = await exportOf(dst, p);
      expect([p, { ...again, exportedAt: null }]).toStrictEqual([p, { ...docs[i], exportedAt: null }]);
    }
  });
});
