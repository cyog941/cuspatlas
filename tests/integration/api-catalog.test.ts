import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REGISTERED_ROUTES } from '@cuspatlas/api';
import { TOOLS } from '@cuspatlas/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CatalogOperation, validateCatalog } from '../../packages/contracts/src/catalog/catalog';
import {
  buildCatalog,
  CAPABILITY_OF,
  ROOT,
  stableJson,
  workerActions,
} from '../../scripts/catalog/build-catalog';
import { registeredScopes } from '../../scripts/catalog/scopes';
import { type CatalogStack, startCatalogStack } from './support/catalog-stack';

/**
 * A4: one operation catalog over every transport. The committed catalog is generated from the code
 * tables and must equal a fresh build; every registered REST route, MCP tool and worker authorize call
 * maps to exactly one entry; no route is registered outside the manifests.
 */
const committedPath = resolve(ROOT, 'packages/contracts/src/catalog/operations.json');
const catalog = buildCatalog();
const fastify = (p: string) => p.replace(/\{(\w+)\}/g, ':$1');

let s: CatalogStack;
beforeAll(async () => {
  s = await startCatalogStack('api_catalog', []);
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
