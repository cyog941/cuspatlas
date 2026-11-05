import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REGISTERED_ROUTES } from '@cuspatlas/api';
import { ACTION_POLICIES } from '@cuspatlas/domain';
import { TOOLS } from '@cuspatlas/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CatalogOperation, validateCatalog } from '../../packages/contracts/src/catalog/catalog';
import {
  ACTION_ALIASES,
  buildCatalog,
  CAPABILITY_OF,
  ROOT,
  stableJson,
  workerActions,
} from '../../scripts/catalog/build-catalog';
import {
  buildScopeRegistry,
  registeredScopes,
  registeredScopes as registryScopes,
} from '../../scripts/catalog/scopes';
import {
  type CatalogStack,
  enrollPortalPrincipal,
  PORTAL_AUDIENCE,
  startCatalogStack,
} from './support/catalog-stack';
import { T_ALPHA } from './support/fixtures';
import { routeRegistrationSites } from './support/route-sites';

/**
 * A4: one operation catalog over every transport. The committed catalog is generated from the code
 * tables and must equal a fresh build; every registered REST route, MCP tool and worker authorize call
 * maps to exactly one entry; no route is registered outside the manifests.
 */
const committedPath = resolve(ROOT, 'packages/contracts/src/catalog/operations.json');
const catalog = buildCatalog();
const fastify = (p: string) => p.replace(/\{(\w+)\}/g, ':$1');

/** A-S4 reviewed registration sites (manifest loops over operation tables, plus /healthz). */
const REVIEWED_ROUTE_SITES: Record<string, number> = {
  'apps/api/src/app.ts: app.get': 1,
  // A2: one loop over AGENT_OPS rows, each with onRequest authentication for its operation id.
  'apps/api/src/routes/agent-ops.ts: app.get': 1,
  'apps/api/src/routes/agent-ops.ts: app.post': 1,
  // A batch 4: one loop over AUTOMATION_OPS rows (A14 webhooks, A15 exports).
  'apps/api/src/routes/automation-ops.ts: app.get': 1,
  'apps/api/src/routes/automation-ops.ts: app.post': 1,
  'apps/api/src/routes/appointments.ts: app.get': 5,
  'apps/api/src/routes/appointments.ts: app.post': 3,
  'apps/api/src/routes/billing-ops-routes.ts: app.get': 1,
  'apps/api/src/routes/billing-ops-routes.ts: app.post': 1,
  'apps/api/src/routes/billing.ts: app.post': 1,
  'apps/api/src/routes/billing.ts: app.get': 1,
  'apps/api/src/routes/clinical-record.ts: app.get': 1,
  'apps/api/src/routes/clinical-record.ts: app.post': 1,
  'apps/api/src/routes/clinical.ts: app.get': 1,
  'apps/api/src/routes/clinical.ts: app.post': 1,
  'apps/api/src/routes/imaging-routes.ts: scope.post': 2,
  'apps/api/src/routes/imaging-routes.ts: scope.get': 2,
  'apps/api/src/routes/migration-ops.ts: app.get': 1,
  'apps/api/src/routes/migration-ops.ts: app.post': 1,
  'apps/api/src/routes/patients.ts: app.post': 8,
  'apps/api/src/routes/patients.ts: app.get': 5,
  'apps/api/src/routes/portal-routes.ts: app.get': 1,
  'apps/api/src/routes/portal-routes.ts: app.post': 1,
  'apps/api/src/routes/proposals.ts: app.post': 3,
  'apps/api/src/routes/proposals.ts: app.get': 1,
  'apps/api/src/routes/scheduling-ops-routes.ts: app.get': 1,
  'apps/api/src/routes/scheduling-ops-routes.ts: app.post': 1,
  'apps/api/src/routes/scheduling.ts: app.post': 7,
  'apps/api/src/routes/scheduling.ts: app.get': 4,
  'apps/api/src/routes/session.ts: app.get': 1,
  'apps/api/src/routes/vocabularies.ts: app.get': 2,
  'apps/api/src/routes/synthetic-tasks.ts: app.post': 2,
  'apps/api/src/routes/synthetic-tasks.ts: app.get': 2,
};

let s: CatalogStack;
beforeAll(async () => {
  s = await startCatalogStack(
    'api_catalog',
    buildScopeRegistry(catalog).scopes.map((x) => x.name),
  );
});
afterAll(async () => {
  await s?.close();
});

describe('A4 operation catalog', () => {
  it('the committed catalog equals a fresh build from the code tables (regenerate on change)', () => {
    expect(readFileSync(committedPath, 'utf8')).toBe(stableJson(catalog));
  });

  it('is structurally valid against the scope registry', () => {
    expect(validateCatalog(catalog, registeredScopes())).toStrictEqual([]);
    process.stdout.write(`\nA4 CATALOG: ${catalog.length} operations\n`);
  });

  it('every registered REST route maps to exactly one catalog entry, and every entry is registered', () => {
    const registered = (REGISTERED_ROUTES.get(s.app) ?? []).map((r) => `${r.method} ${r.url}`).sort();
    const expected = catalog
      .filter((o) => o.rest)
      .map((o) => `${o.rest?.method.toUpperCase()} ${fastify(o.rest?.path ?? '')}`)
      .sort();
    expect(registered).toStrictEqual(expected);
    expect(new Set(registered).size).toBe(registered.length);
  });

  it('every MCP tool maps to exactly one catalog entry with the mcp transport', () => {
    const byTool = new Map(catalog.filter((o) => o.mcpTool).map((o) => [o.mcpTool, o]));
    expect(TOOLS.map((t) => t.name).sort()).toStrictEqual([...byTool.keys()].sort());
    for (const t of TOOLS) expect(byTool.get(t.name)?.operation).toBe(t.operationId);
  });

  it('every worker authorize call is a worker-transport catalog operation', () => {
    const workers = catalog.filter((o) => o.transports.includes('worker')).map((o) => o.operation);
    expect(workerActions().sort()).toStrictEqual(workers.sort());
    expect(workers.length).toBeGreaterThanOrEqual(2);
  });

  it('capability-only actions are checked by domain code and attached to an existing operation', () => {
    const domainSrc = (dir: string): string =>
      readdirSync(dir, { withFileTypes: true })
        .map((e) =>
          e.isDirectory()
            ? domainSrc(resolve(dir, e.name))
            : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')
              ? readFileSync(resolve(dir, e.name), 'utf8')
              : '',
        )
        .join('\n');
    const src = domainSrc(resolve(ROOT, 'packages/domain/src'));
    const ops = new Set(catalog.map((o) => o.operation));
    for (const [cap, owner] of Object.entries(CAPABILITY_OF)) {
      expect(ops.has(owner), `${cap} owner ${owner}`).toBe(true);
      const scope = catalog.find((o) => o.operation === cap)?.scope ?? '';
      expect(src.includes(`'${cap}'`) || src.includes(`'${scope}'`), cap).toBe(true);
    }
  });

  it('no route is registered outside the manifest tables (structural bypass check)', () => {
    const dir = resolve(ROOT, 'apps/api/src/routes');
    const files = [...readdirSync(dir).map((f) => resolve(dir, f)), resolve(ROOT, 'apps/api/src/app.ts')];
    const offenders: string[] = [];
    for (const f of files.filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(
        /\bapp\.(get|post|put|patch|delete|route|all)(?:<[^>]*>)?\(\s*(['"`])([^'"`]*)\2/g,
      )) {
        if (!(m[1] === 'get' && m[3] === '/healthz')) offenders.push(`${f}: ${m[1]} ${m[3]}`);
      }
      if (/\bapp\.(put|patch|delete|route|all)\(/.test(src)) offenders.push(`${f}: non-manifest verb`);
    }
    expect(offenders).toStrictEqual([]);
  });

  it('A-S4: every route registration site, including plugin scopes, aliases and computed verbs, is reviewed', () => {
    // Reviewed manifest loops: each registers only rows of its operation table (ROUTES, PORTAL_OPS,
    // IMAGING_OPS, ...); the runtime onRoute list above must still equal the catalog exactly.
    expect(routeRegistrationSites()).toStrictEqual(REVIEWED_ROUTE_SITES);
    // The scanner itself catches the bypass shapes a plain `app.get('/x')` regex misses.
    const dir = resolve(ROOT, 'node_modules/.cache/h1-route-fixture/apps/api/src');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'bypass.ts'),
      [
        'export function sneaky(app: FastifyInstance, m: string) {',
        '  const r = app;',
        "  r.get('/v1/x', h);",
        '  app.register(async (child) => { child.post(path, h); });',
        "  app[m]('/v1/y', h);",
        "  app.route({ method: 'GET', url: '/v1/z', handler: h });",
        '}',
      ].join('\n'),
    );
    expect(routeRegistrationSites(resolve(dir, '../../..'))).toStrictEqual({
      'apps/api/src/bypass.ts: app.[m]': 1,
      'apps/api/src/bypass.ts: app.route': 1,
      'apps/api/src/bypass.ts: child.post': 1,
      'apps/api/src/bypass.ts: r.get': 1,
    });
  });

  it('A-S5: portal and bridge routes are enabled in the catalog stack', () => {
    const urls = (REGISTERED_ROUTES.get(s.app) ?? []).map((r) => r.url);
    for (const o of catalog.filter((x) => ['portal', 'device', 'pairing'].includes(x.authorization))) {
      expect(urls, o.operation).toContain(fastify(o.rest?.path ?? ''));
    }
  });

  it('A-S5: no action alias is weaker than the operation it stands for', () => {
    const weaker: string[] = [];
    for (const [op, action] of Object.entries(ACTION_ALIASES)) {
      const own = (
        ACTION_POLICIES as Record<string, { scope: string | null; principals: readonly string[] }>
      )[op];
      const via = (
        ACTION_POLICIES as Record<string, { scope: string | null; principals: readonly string[] }>
      )[action];
      if (!via) weaker.push(`${op}: alias ${action} has no policy row`);
      else if (own && (own.scope !== via.scope || via.principals.some((p) => !own.principals.includes(p))))
        weaker.push(`${op}: alias ${action} differs from its own row`);
      // A command authorized through a read alias must carry an additional capability check.
      else if (!/\.(list|read|search|get)$/.test(op) && !Object.values(CAPABILITY_OF).includes(op))
        weaker.push(`${op}: command aliased to ${action} without a capability check`);
    }
    expect(weaker).toStrictEqual([]);
    expect(registryScopes().size).toBeGreaterThan(40);
  });

  it('A-S5: the allow path reaches authorize for one operation per principal kind', async () => {
    const path = (op: string) => catalog.find((o) => o.operation === op)?.rest?.path as string;
    for (const who of ['humanAll', 'serviceAll'] as const) {
      const loads = s.membershipLoads.length;
      const res = await s.rest(await s.token(who), 'GET', path('scheduling.locations.list'), undefined);
      expect([who, res.statusCode]).toStrictEqual([who, 200]);
      // Authentication and authorize each load the live membership.
      expect(s.membershipLoads.length - loads, who).toBeGreaterThanOrEqual(2);
    }
    const { principalRef } = await enrollPortalPrincipal(s);
    const portal = await s.rest(
      await s.token(principalRef, PORTAL_AUDIENCE, T_ALPHA),
      'GET',
      path('portal.session.read'),
      undefined,
    );
    expect(portal.statusCode).toBe(200);
    // Device: the paired-bridge allow path (signed device credential) is exercised in
    // imaging-bridge.test.ts; the catalog stack proves the bridge routes are registered (above).
  });

  it('every staff route reaches authorize with its catalog action under the runtime role', async () => {
    // A principal with an active membership but no scope: each staff route must load the live
    // membership twice (authentication, then authorize) and record a denial attempt naming the catalog operation.
    const tok = await s.token('humanNone');
    const missed: string[] = [];
    const staff = catalog.filter(
      (o): o is CatalogOperation & { rest: NonNullable<CatalogOperation['rest']> } =>
        o.authorization === 'authorize' && o.rest !== undefined && o.scope !== null,
    );
    for (const o of staff) {
      const loads = s.membershipLoads.length;
      const seen = s.attempts.length;
      const url = o.rest.path.replace(/\{(\w+)\}/g, () => crypto.randomUUID());
      const res = await s.rest(tok, o.rest.method === 'get' ? 'GET' : 'POST', url, {});
      // A service-only operation refuses a human on kind before scope.
      const reason = o.principals.includes('human') ? 'scope_missing' : 'principal_kind_denied';
      const attempt = s.attempts
        .slice(seen)
        .find((a) => a.reasonCode === reason && (a.operation === o.operation || a.operation === o.action));
      if (res.statusCode !== 403 || s.membershipLoads.length - loads < 2 || !attempt) {
        missed.push(`${o.operation}: ${res.statusCode} loads+${s.membershipLoads.length - loads}`);
      }
    }
    expect(missed).toStrictEqual([]);
    expect(staff.length).toBeGreaterThan(250);
  });

  it('the validator rejects duplicates, unregistered scopes, camel-case scopes and keyed queries', () => {
    const base = catalog.find((o) => o.mcpTool && o.kind === 'query') as CatalogOperation;
    const bad: CatalogOperation[] = [
      base,
      { ...base, operation: 'x.dup' },
      {
        ...base,
        operation: 'x.scope',
        rest: undefined as never,
        mcpTool: 'x_scope',
        scope: 'receivablesRead',
      },
      { ...base, operation: 'x.unreg', rest: undefined as never, mcpTool: 'x_unreg', scope: 'ghost.read' },
      {
        ...base,
        operation: 'x.keyed',
        rest: undefined as never,
        mcpTool: 'x_keyed',
        idempotency: 'required',
      },
      { ...base, operation: 'x.sql', rest: undefined as never, mcpTool: 'run_sql', scope: null },
    ];
    const d = validateCatalog(bad, registeredScopes());
    expect(d.some((x) => x.startsWith('x.dup: duplicate rest'))).toBe(true);
    expect(d.some((x) => x.startsWith('x.dup: duplicate tool'))).toBe(true);
    expect(d).toContain('x.scope: camel-case scope receivablesRead; write it as receivables.read');
    expect(d).toContain('x.unreg: unregistered scope ghost.read');
    expect(d).toContain('x.keyed: query declared idempotency required');
    expect(d).toContain('x.sql: forbidden tool kind run_sql');
  });
});
