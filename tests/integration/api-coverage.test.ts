import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REGISTERED_ROUTES } from '@cuspatlas/api';
import { TOOLS } from '@cuspatlas/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog, ROOT, workerActions } from '../../scripts/catalog/build-catalog';
import {
  assertNoEntitlementGate,
  CAPABILITY_ROWS,
  describeCoverage,
  describeHiddenOperations,
  parseCapabilityMatrix,
  renderCoverageMd,
  renderNoTierMd,
} from '../../scripts/catalog/coverage';
import { buildScopeRegistry, registeredScopes } from '../../scripts/catalog/scopes';
import { type CatalogStack, startCatalogStack } from './support/catalog-stack';

/**
 * A19 close-out: capability coverage over the matrix rows (A-owned rows, and read-only every other
 * workstream's rows in docs/CAPABILITIES.md), the no-tier attestation and the hidden-operation check.
 */
const catalog = buildCatalog();
const matrix = parseCapabilityMatrix(readFileSync(resolve(ROOT, 'docs/CAPABILITIES.md'), 'utf8'));

let s: CatalogStack;
beforeAll(async () => {
  s = await startCatalogStack(
    'api_coverage',
    buildScopeRegistry(catalog).scopes.map((x) => x.name),
  );
});
afterAll(async () => {
  await s?.close();
});

describe('A19 capability coverage', () => {
  it('every matrix row is mapped, and every A-owned row resolves to operations and a negative case', () => {
    const report = describeCoverage({ catalog, matrix, scopes: registeredScopes() });
    expect(report.unmapped).toStrictEqual([]);
    expect(report.scopeDefects).toStrictEqual([]);
    for (const r of report.rows.filter((x) => x.owners.includes('A'))) {
      expect(r.status, r.domain).toBe('covered');
      expect(r.operations.length, r.domain).toBeGreaterThan(0);
      expect(r.negativeCases.length, r.domain).toBeGreaterThan(0);
    }
    // Every row is either covered with a negative case or an explicit dated gap: nothing is omitted.
    for (const r of report.rows) {
      expect(['covered', 'gap'], r.domain).toContain(r.status);
      if (r.status === 'gap') expect(r.gapSince, r.domain).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(report.rows.length).toBe(matrix.length + CAPABILITY_ROWS.filter((x) => x.planOnly).length);
  });

  it('a row with no operation is a gap, and a workstream with no readable descriptors is unknown', () => {
    const withoutImaging = catalog.filter((o) => o.owner !== 'I');
    const report = describeCoverage({ catalog: withoutImaging, matrix, scopes: registeredScopes() });
    expect(report.rows.find((r) => r.domain === 'Imaging/documents')?.status).toBe('unknown');
    const extra = describeCoverage({
      catalog,
      matrix: [...matrix, { domain: 'Teleportation', release: 'P9' }],
      scopes: registeredScopes(),
    });
    expect(extra.unmapped).toStrictEqual(['Teleportation']);
    expect(extra.rows.find((r) => r.domain === 'Teleportation')?.status).toBe('unknown');
  });

  it('a scope used by an operation but absent from the registry fails the coverage check', () => {
    const scopes = new Set(registeredScopes());
    scopes.delete('webhooks.read');
    const report = describeCoverage({ catalog, matrix, scopes });
    expect(report.scopeDefects.some((d) => d.startsWith('webhooks.subscriptions.list'))).toBe(true);
  });

  it('reports the count of operations with and without an MCP surface', () => {
    const report = describeCoverage({ catalog, matrix, scopes: registeredScopes() });
    expect(report.mcp.with + report.mcp.without).toBe(catalog.length);
    expect(report.mcp.without).toBeGreaterThan(0);
    expect(report.mcp.withoutOperations.length).toBe(report.mcp.without);
  });
});

describe('A19 no-tier attestation', () => {
  it('passes over every descriptor and code path in the repository', () => {
    const r = assertNoEntitlementGate({ catalog });
    expect(r.findings).toStrictEqual([]);
    expect(r.filesScanned).toBeGreaterThan(200);
    expect(r.descriptorsScanned).toBe(catalog.length);
  });

  it('fails on a deliberately injected entitlement check in code and in a descriptor', () => {
    const dir = resolve(ROOT, 'node_modules/.cache/a19-fixture/packages/domain/src');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'gate.ts'),
      "export const gate = (t: { entitlements: string[] }) => t.entitlements.includes('mcp');\n",
    );
    const code = assertNoEntitlementGate({
      catalog,
      roots: [resolve(ROOT, 'node_modules/.cache/a19-fixture')],
    });
    expect(code.findings.map((f) => f.split(':')[0])).toContain('packages/domain/src/gate.ts');
    const first = catalog[0];
    if (!first) throw new Error('empty catalog');
    const tampered = [{ ...first, featureKey: 'mcp-pro' }, ...catalog.slice(1)];
    expect(assertNoEntitlementGate({ catalog: tampered }).findings.length).toBeGreaterThan(0);
  });

  it('fails rather than passing when the scan cannot complete', () => {
    expect(() =>
      assertNoEntitlementGate({ catalog, roots: [resolve(ROOT, 'node_modules/.cache/a19-missing')] }),
    ).toThrow(/attestation incomplete/);
  });
});

describe('A19 hidden operations', () => {
  const transports = () => ({
    rest: REGISTERED_ROUTES.get(s.app) ?? [],
    mcpTools: TOOLS.map((t) => t.name),
    workerActions: workerActions(),
  });

  it('every REST, portal, bridge, MCP and worker route is a catalog operation', () => {
    const r = describeHiddenOperations({ catalog, ...transports() });
    expect(r.hidden).toStrictEqual([]);
    expect(r.counts.rest + r.counts.portal + r.counts.bridge).toBe(
      (REGISTERED_ROUTES.get(s.app) ?? []).length,
    );
    expect(r.counts.mcp).toBe(TOOLS.length);
  });

  it('detects an injected route and tool absent from the catalog', () => {
    const t = transports();
    const r = describeHiddenOperations({
      catalog,
      rest: [...t.rest, { method: 'POST', url: '/v1/ui-only/discount' }],
      mcpTools: [...t.mcpTools, 'ui_only_discount'],
      workerActions: [...t.workerActions, 'billing.secretSweep'],
    });
    expect(r.hidden).toStrictEqual([
      'mcp ui_only_discount',
      'rest POST /v1/ui-only/discount',
      'worker billing.secretSweep',
    ]);
  });
});

describe('A19 published documents', () => {
  it('the committed coverage document and attestation equal a fresh render', () => {
    const report = describeCoverage({ catalog, matrix, scopes: registeredScopes() });
    expect(readFileSync(resolve(ROOT, 'docs/api/capability-coverage.md'), 'utf8')).toBe(
      renderCoverageMd(report),
    );
    expect(readFileSync(resolve(ROOT, 'docs/api/no-tier-attestation.md'), 'utf8')).toBe(
      renderNoTierMd(assertNoEntitlementGate({ catalog }), catalog.length),
    );
  });
});
