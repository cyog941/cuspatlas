import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentedOperations } from '../../apps/api/src/contract-drift';
import { createClient } from '../../packages/client/src/index';
import { lintRepresentation } from '../../packages/contracts/src/catalog/representation';
import { buildCatalog, ROOT } from '../../scripts/catalog/build-catalog';
import { renderClient } from '../../scripts/catalog/client';
import { defsOf, loadSchemaFiles, parseSchemaRef, reachableDefs } from '../../scripts/catalog/schemas';
import { type CatalogStack, startCatalogStack } from './support/catalog-stack';
import { patientBody } from './support/patient-fixtures';

/**
 * A1 contract gate: the OpenAPI document agrees with the catalog, every schema reachable from an
 * operation keeps the shared representations, and the generated client is current, compiles (tsc in
 * CI) and calls the real app.
 */
const catalog = buildCatalog();
const files = loadSchemaFiles();
const openapi = readFileSync(resolve(ROOT, 'docs/api/openapi.yaml'), 'utf8');

/** Defs of each file reachable from an operation's request or success schema. */
function reachable(): Map<string, { request: Set<string>; any: Set<string> }> {
  const out = new Map<string, { request: Set<string>; any: Set<string> }>();
  const roots = (side: 'request' | 'any') => {
    const m = new Map<string, Set<string>>();
    for (const o of catalog) {
      for (const ref of side === 'request'
        ? [o.rest?.requestSchema]
        : [o.rest?.requestSchema, o.rest?.successSchema]) {
        const r = ref ? parseSchemaRef(ref) : null;
        if (r) m.set(r.file, (m.get(r.file) ?? new Set()).add(r.def));
      }
    }
    return m;
  };
  const req = roots('request');
  const any = roots('any');
  for (const [file, doc] of Object.entries(files)) {
    out.set(file, {
      request: reachableDefs(doc, req.get(file) ?? []),
      any: reachableDefs(doc, any.get(file) ?? []),
    });
  }
  return out;
}

/**
 * Defects in schema definitions no operation reaches (adapter-internal shapes). Listed so they stay
 * visible: RemittanceAdvice mirrors the fake clearinghouse's ERA-like advice with scalar minor-unit
 * amounts beside a currency; it is not a public contract but must become Money before it is one.
 */
const UNREACHABLE_DEFECTS = [
  'billing.schema.json#/$defs/RemittanceAdvice:totalPaidMinor',
  'billing.schema.json#/$defs/RemittanceAdvice/properties/lines/items:contractualMinor',
  'billing.schema.json#/$defs/RemittanceAdvice/properties/lines/items:paidMinor',
  'billing.schema.json#/$defs/RemittanceAdvice/properties/lines/items:patientResponsibilityMinor',
];

let s: CatalogStack;
beforeAll(async () => {
  s = await startCatalogStack('api_contract_gate', ['patients.read', 'patients.write']);
});
afterAll(async () => {
  await s?.close();
});

describe('A1 OpenAPI conformance with the catalog', () => {
  it('documents exactly the catalog REST operations (method, path, operationId)', () => {
    const documented = documentedOperations(openapi)
      .map((o) => `${o.method} ${o.path} ${o.operationId}`)
      .sort();
    const expected = catalog
      .filter((o) => o.rest)
      .map((o) => `${o.rest?.method} ${o.rest?.path} ${o.operation}`)
      .sort();
    expect(documented).toStrictEqual(expected);
  });
});

describe('A1 shared representations', () => {
  const r = reachable();

  it('no reachable schema has a tenant field, bare entity id, scalar money or zoneless timestamp', () => {
    const defects: string[] = [];
    for (const [file, doc] of Object.entries(files)) {
      const sets = r.get(file);
      for (const def of sets?.any ?? []) {
        const request = sets?.request.has(def) ?? false;
        for (const d of lintRepresentation(defsOf(doc)[def], `${file}#/$defs/${def}`, request)) {
          defects.push(`${d.rule} ${d.at}:${d.field}`);
        }
      }
    }
    expect(defects).toStrictEqual([]);
  });

  it('unreachable definitions keep only the reviewed defects (none silently accepted)', () => {
    const found: string[] = [];
    for (const [file, doc] of Object.entries(files)) {
      const used = r.get(file)?.any ?? new Set();
      for (const [def, node] of Object.entries(defsOf(doc))) {
        if (used.has(def)) continue;
        for (const d of lintRepresentation(node, `${file}#/$defs/${def}`)) found.push(`${d.at}:${d.field}`);
      }
    }
    expect(found.sort()).toStrictEqual([...UNREACHABLE_DEFECTS].sort());
  });

  it('the lint rejects a synthetic violation set with the field named, and passes the clean set', () => {
    const bad = {
      type: 'object',
      properties: {
        tenantId: { type: 'string' },
        patientId: { type: 'string' },
        amountMinor: { type: 'integer' },
        currency: { type: 'string' },
        recordedAt: { type: 'string' },
        nested: { type: 'object', properties: { x: { type: 'string' } } },
      },
    };
    const rules = lintRepresentation(bad, 'synthetic', true).map((d) => `${d.rule}:${d.field}`);
    expect(rules.sort()).toStrictEqual(
      [
        'openObject:',
        'openObject:',
        'tenantField:tenantId',
        'bareEntityId:patientId',
        'scalarMoney:amountMinor',
        'zonelessTimestamp:recordedAt',
      ].sort(),
    );
    const clean = {
      type: 'object',
      additionalProperties: false,
      properties: {
        patientRef: { type: 'string' },
        amount: {
          type: 'object',
          additionalProperties: false,
          properties: { currency: { type: 'string' }, minor: { type: 'integer' } },
        },
        recordedAt: { type: 'string', format: 'date-time' },
      },
    };
    expect(lintRepresentation(clean, 'synthetic', true)).toStrictEqual([]);
  });

  it('A-S6: id lists, tenant-like fields, union types, money by shape and open request maps are caught', () => {
    const bad = {
      type: 'object',
      additionalProperties: false,
      properties: {
        patientIds: { type: 'array', items: { type: 'string' } },
        practiceId: { type: 'string' },
        organizationId: { type: 'string' },
        balanceMinor: { type: ['integer', 'null'] },
        copay: { type: 'integer' },
        fee: { type: 'number' },
        charge: {
          type: 'object',
          additionalProperties: false,
          properties: { value: { type: 'integer' }, currency: { type: 'string' } },
        },
        settledAt: { type: ['string', 'null'] },
        observed: { type: 'string', format: 'date', description: 'not a timestamp' },
        loggedTimestamp: { type: 'string' },
        labels: { type: 'object', additionalProperties: true },
        extras: { type: 'object', additionalProperties: { type: 'string' } },
        tags: { type: 'object', patternProperties: { '^x': { type: 'string' } } },
      },
    };
    const rules = lintRepresentation(bad, 'synthetic', true).map((d) => `${d.rule}:${d.field}`);
    expect(rules.sort()).toStrictEqual(
      [
        'bareEntityId:patientIds',
        'tenantField:practiceId',
        'tenantField:organizationId',
        'scalarMoney:balanceMinor',
        'scalarMoney:copay',
        'scalarMoney:fee',
        'scalarMoney:value',
        'zonelessTimestamp:settledAt',
        'zonelessTimestamp:loggedTimestamp',
        'openObject:labels',
        'openObject:extras',
        'openObject:tags',
      ].sort(),
    );
    // Response-side maps stay allowed; counts are not money.
    const response = {
      type: 'object',
      properties: {
        totals: { type: 'object', additionalProperties: { type: 'integer' } },
        paymentCount: { type: 'integer' },
      },
    };
    expect(lintRepresentation(response, 'synthetic', false)).toStrictEqual([]);
  });

  it('every operation documents refusals through the one shared Refusal body', () => {
    expect(openapi).toContain(
      "$ref: '../../packages/contracts/src/synthetic-task.schema.json#/$defs/Refusal'",
    );
    const refusal = defsOf(files['synthetic-task.schema.json'] ?? {}).Refusal as {
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(refusal.required).toEqual(expect.arrayContaining(['code', 'retryable', 'correlationId']));
    expect(refusal.additionalProperties).toBe(false);
    for (const o of catalog.filter((x) => x.rest && x.authorization !== 'public')) {
      expect(o.refusals.length, o.operation).toBeGreaterThan(0);
    }
  });
});

describe('A1 generated client', () => {
  it('is current: regenerating from the unchanged tree produces no diff', () => {
    const committed = readFileSync(resolve(ROOT, 'packages/client/src/generated.ts'), 'utf8');
    expect(committed).toBe(renderClient(catalog));
  });

  it('A-S6: query types are closed to the documented parameters', () => {
    const gen = readFileSync(resolve(ROOT, 'packages/client/src/generated.ts'), 'utf8');
    const entry = (op: string) =>
      gen.slice(gen.indexOf(`  ${JSON.stringify(op)}: {\n`)).split('\n  };')[0] as string;
    expect(entry('syntheticTasks.list')).toContain(
      'query: { readonly limit?: string; readonly cursor?: string; };',
    );
    expect(entry('syntheticTasks.create')).toContain('query: Record<string, never>;');
    expect(gen).not.toMatch(/query: Readonly<Record<string, string>>/);
  });

  it('has one typed entry per catalog REST operation', async () => {
    const { OPERATIONS } = await import('../../packages/client/src/generated');
    expect(Object.keys(OPERATIONS).sort()).toStrictEqual(
      catalog
        .filter((o) => o.rest)
        .map((o) => o.operation)
        .sort(),
    );
  });

  it('calls the real app: create, read, a refusal (never ok) and an unknown property rejected', async () => {
    const token = await s.token('humanAll');
    const client = createClient({
      baseUrl: '',
      token,
      fetch: async (url, init) => {
        const res = await s.app.inject({
          method: init.method as 'GET' | 'POST',
          url,
          headers: init.headers as Record<string, string>,
          ...(typeof init.body === 'string' ? { payload: init.body } : {}),
        });
        return new Response(res.statusCode === 204 ? null : res.body, {
          status: res.statusCode,
          headers: res.headers as Record<string, string>,
        });
      },
    });
    const created = await client.call('patients.create', {
      body: patientBody('Synthetic Client Person') as never,
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const patientRef = created.ok ? (created.data as { data: { patientRef: string } }).data.patientRef : '';
    const read = await client.call('patients.read', { params: { patientRef } });
    expect(read.ok).toBe(true);
    const missing = await client.call('patients.read', { params: { patientRef: crypto.randomUUID() } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect([missing.status, missing.refusal.code]).toStrictEqual([404, 'not_found']);
    const smuggled = await client.call('patients.create', {
      body: {
        ...(patientBody('Synthetic Client Person Two') as object),
        tenantId: crypto.randomUUID(),
      } as never,
    });
    expect(smuggled.ok).toBe(false);
    if (!smuggled.ok) expect(smuggled.status).toBe(400);
  });
});
