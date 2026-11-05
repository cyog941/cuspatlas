import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REGISTERED_ROUTES } from '@cuspatlas/api';
import { ACTION_POLICIES } from '@cuspatlas/domain';
import { TOOLS, toolCatalogDrift } from '@cuspatlas/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog, ROOT } from '../../scripts/catalog/build-catalog';
import { loadProcedureInputs, procedureGaps } from '../../scripts/catalog/procedure';
import { registeredScopes } from '../../scripts/catalog/scopes';
import { type CatalogStack, startCatalogStack } from './support/catalog-stack';
import { patientBody } from './support/patient-fixtures';

/**
 * A6: the MCP surface is exactly the catalog's staff operations with an MCP transport, and one matrix
 * over ALL workstreams aggregates the per-workstream parity matrices (S17, C18, E9, I9, B10), which
 * keep their own specific assertions.
 */
const catalog = buildCatalog();
const fastify = (p: string) => p.replace(/\{(\w+)\}/g, ':$1');

/** Staff REST operations that are deliberately not MCP tools (byte transports and the session read). */
const REST_ONLY = [
  'imaging.export.blobs',
  'imaging.ingress.upload',
  'imaging.objects.content',
  'session.read',
];

let s: CatalogStack;
let listed: Awaited<ReturnType<CatalogStack['mcpList']>> = [];

beforeAll(async () => {
  s = await startCatalogStack('mcp_catalog_parity', ['patients.read', 'patients.write']);
  listed = await s.mcpList('humanAll');
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe('A6 MCP parity from the catalog', () => {
  it('tools/list equals the catalog MCP operations, with the read-only hint from the catalog kind', () => {
    const expected = catalog.filter((o) => o.mcpTool).map((o) => `${o.mcpTool}:${o.kind === 'query'}`);
    expect(listed.map((t) => `${t.name}:${t.annotations?.readOnlyHint}`).sort()).toStrictEqual(
      expected.sort(),
    );
  });

  it('the startup check reports a hand-added, off-catalog, remapped or missing tool', () => {
    expect(toolCatalogDrift(TOOLS)).toStrictEqual([]);
    const base = TOOLS[0] as (typeof TOOLS)[number];
    expect(toolCatalogDrift([...TOOLS, { ...base, name: 'hand_added_tool' }])).toContain(
      'tool hand_added_tool is not in the operation catalog',
    );
    expect(toolCatalogDrift([...TOOLS.slice(1), { ...base, operationId: 'ghost.operation' }])).toContain(
      `tool ${base.name} maps to ghost.operation; the catalog says ${base.operationId}`,
    );
    expect(toolCatalogDrift(TOOLS.slice(1))).toContain(`catalog tool ${base.name} is not registered`);
    expect(toolCatalogDrift([...TOOLS.slice(1), { ...base, readOnly: !base.readOnly }])).toContain(
      `tool ${base.name} read-only hint disagrees with the catalog kind`,
    );
  });

  it('one matrix over all workstreams: REST registered, MCP listed, policy, OpenAPI and harness', () => {
    const registered = new Set((REGISTERED_ROUTES.get(s.app) ?? []).map((r) => `${r.method} ${r.url}`));
    const names = new Set(listed.map((t) => t.name));
    const inputs = loadProcedureInputs(catalog, registeredScopes(), ACTION_POLICIES);
    const gaps: string[] = [];
    const counts: Record<string, Record<string, number>> = {};
    for (const o of catalog) {
      counts[o.owner] ??= { ops: 0, rest: 0, mcp: 0, portal: 0, bridge: 0, worker: 0 };
      const c = counts[o.owner] as Record<string, number>;
      c.ops = (c.ops ?? 0) + 1;
      for (const t of o.transports) c[t] = (c[t] ?? 0) + 1;
      if (o.rest && !registered.has(`${o.rest.method.toUpperCase()} ${fastify(o.rest.path)}`)) {
        gaps.push(`${o.operation}:registered`);
      }
      if (o.mcpTool && !names.has(o.mcpTool)) gaps.push(`${o.operation}:mcp`);
      if (o.authorization === 'authorize' && o.rest && !o.mcpTool && !REST_ONLY.includes(o.operation)) {
        gaps.push(`${o.operation}:mcpMissing`);
      }
      for (const g of procedureGaps(o, inputs)) gaps.push(`${o.operation}:${g}`);
    }
    expect(gaps).toStrictEqual([]);
    process.stdout.write(
      `\nA6 PARITY MATRIX (${catalog.length} operations, ${listed.length} tools)\n${Object.entries(counts)
        .map(([w, c]) => `${w}: ${JSON.stringify(c)}`)
        .join('\n')}\n`,
    );
  });

  it('the per-workstream parity matrices remain with their specific assertions', () => {
    for (const f of [
      'scheduling-parity.test.ts',
      'clinical-parity.test.ts',
      'comms-parity.test.ts',
      'imaging-parity.test.ts',
      'billing-parity.test.ts',
    ]) {
      expect(readFileSync(resolve(ROOT, 'tests/integration', f), 'utf8'), f).toContain('describe(');
    }
  });

  it('the same command through REST and MCP yields the same result shape and version', async () => {
    const rest = await s.rest(
      await s.token('humanAll'),
      'POST',
      '/v1/patients',
      patientBody('Synthetic Parity Rest'),
    );
    expect(rest.statusCode).toBe(201);
    const viaMcp = await s.mcpCall('humanAll', 'patients_create', {
      ...(patientBody('Synthetic Parity Mcp') as Record<string, unknown>),
      idempotencyKey: crypto.randomUUID(),
    });
    expect(viaMcp.isError, JSON.stringify(viaMcp.body)).toBe(false);
    const shape = (v: unknown, p = ''): string[] =>
      v !== null && typeof v === 'object' && !Array.isArray(v)
        ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [
            `${p}${k}`,
            ...shape(x, `${p}${k}.`),
          ])
        : [];
    const restBody = rest.json() as Record<string, unknown>;
    expect(shape(viaMcp.body).sort()).toStrictEqual(shape(restBody).sort());
    const version = (b: Record<string, unknown>) => (b.data as { version?: number } | undefined)?.version;
    expect(version(viaMcp.body)).toBe(version(restBody));
  });

  it('a wrong-audience (REST) credential is refused before any tool runs', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(s.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${await s.token('humanAll')}` } },
    });
    const client = new Client({ name: 'synthetic-wrong-audience', version: '0.0.0' });
    await expect(client.connect(transport)).rejects.toThrow();
    await client.close().catch(() => undefined);
  });
});
