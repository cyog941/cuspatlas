import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from '@cuspatlas/api';
import { buildMcpServer } from '@cuspatlas/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeprecationEntry } from '../../packages/contracts/src/catalog/catalog';
import {
  type Baseline,
  classifyChange,
  type InputShape,
} from '../../packages/contracts/src/catalog/change-control';
import { DEPRECATIONS } from '../../packages/contracts/src/catalog/deprecation';
import { buildBaseline, gateViolations, readBaseline } from '../../scripts/catalog/baseline';
import { buildCatalog, ROOT } from '../../scripts/catalog/build-catalog';
import { renderSunsetMd } from '../../scripts/catalog/docs';
import { type CatalogStack, MCP_AUDIENCE, startCatalogStack } from './support/catalog-stack';
import { patientBody } from './support/patient-fixtures';

/** A5: change control against the committed baseline, deprecation markers and the sunset register. */
const catalog = buildCatalog();
const current = buildBaseline(catalog);

const op = (input: InputShape, extra: Partial<Baseline['operations'][number]> = {}) => ({
  version: 1,
  operations: [
    {
      operation: 'x.op',
      transports: ['rest', 'mcp'],
      scope: 'x.read',
      principals: ['human'],
      input,
      ...extra,
    },
  ],
});
const obj = (properties: Record<string, InputShape>, required: string[] = [], closed = true): InputShape => ({
  type: ['object'],
  properties,
  required,
  closed,
});
const reasons = (a: Baseline, b: Baseline) =>
  classifyChange(a, b).map((c) => `${c.class} ${c.path} ${c.reason}`);

describe('A5 change classification', () => {
  const str: InputShape = { type: ['string'], maxLength: 100 };
  const before = op(
    obj({ name: str, kind: { enum: ['"a"', '"b"'] }, note: { type: ['null', 'string'] } }, ['name']),
  );

  it('adding an optional property or a new operation is additive', () => {
    const after = op(
      obj({ name: str, kind: { enum: ['"a"', '"b"'] }, note: { type: ['null', 'string'] }, extra: str }, [
        'name',
      ]),
    );
    expect(reasons(before, after)).toStrictEqual([]);
    const more = {
      version: 1,
      operations: [...after.operations, { ...after.operations[0], operation: 'x.new' } as never],
    };
    expect(reasons(before, more)).toStrictEqual(['additive $ new operation']);
  });

  it('removing a field, a new required field, a narrowed enum, a shorter maximum and non-null are breaking', () => {
    const after = op(
      obj(
        {
          name: { type: ['string'], maxLength: 50 },
          kind: { enum: ['"a"'] },
          note: { type: ['string'] },
          must: str,
        },
        ['must', 'name'],
      ),
    );
    expect(reasons(before, after).sort()).toStrictEqual(
      [
        'breaking $.must new required property',
        'breaking $.name maxLength tightened',
        'breaking $.kind enum narrowed',
        'breaking $.note nullable made non-null',
      ].sort(),
    );
    const removed = op(obj({ name: str, kind: { enum: ['"a"', '"b"'] } }, ['name']));
    expect(reasons(before, removed)).toStrictEqual(['breaking $.note property removed']);
  });

  it('removing or renaming an operation, or dropping a transport or principal, is breaking', () => {
    expect(reasons(before, { version: 1, operations: [] })).toStrictEqual([
      'breaking $ operation removed or renamed',
    ]);
    const restOnly = op(before.operations[0]?.input as InputShape, { transports: ['rest'] });
    expect(reasons(before, restOnly)).toStrictEqual(['breaking $ transport mcp dropped']);
  });

  it('a baseline that cannot be ordered stops the pipeline instead of defaulting to additive', () => {
    expect(() => classifyChange({ version: 2, operations: [] }, { version: 1, operations: [] })).toThrow(
      'cannot classify',
    );
  });

  it('the gate refuses a breaking change without a deprecation entry or before its sunset', () => {
    const changes = classifyChange(before, { version: 1, operations: [] });
    expect(gateViolations(changes, [], '2026-11-04')).toStrictEqual([
      'x.op $: operation removed or renamed (no deprecation entry with a sunset date)',
    ]);
    const entry: DeprecationEntry = {
      operation: 'x.op',
      announced: '2026-11-01',
      sunset: '2027-05-01',
      replacedBy: null,
      note: 'synthetic',
    };
    expect(gateViolations(changes, [entry], '2026-11-04')).toStrictEqual([
      'x.op $: operation removed or renamed (deprecated but its sunset 2027-05-01 has not passed)',
    ]);
    expect(gateViolations(changes, [entry], '2027-05-02')).toStrictEqual([]);
  });
});

describe('A5 committed baseline and sunset register', () => {
  it('the committed baseline equals the current published contract (no unreviewed change)', () => {
    const committed = readBaseline();
    expect(
      gateViolations(classifyChange(committed, current), DEPRECATIONS, new Date().toISOString().slice(0, 10)),
    ).toStrictEqual([]);
    expect(committed).toStrictEqual(current);
  });

  it('the sunset register is generated from the deprecation entries and agrees with the catalog', () => {
    expect(readFileSync(resolve(ROOT, 'docs/api/sunset-register.md'), 'utf8')).toBe(
      renderSunsetMd(DEPRECATIONS),
    );
    const marked = catalog.filter((o) => o.status === 'deprecated').map((o) => o.operation);
    expect(marked.sort()).toStrictEqual(DEPRECATIONS.map((d) => d.operation).sort());
    for (const d of DEPRECATIONS) expect(d.sunset > d.announced, d.operation).toBe(true);
  });
});

describe('A5 a deprecated operation still answers, audits and carries its markers', () => {
  const entry: DeprecationEntry = {
    operation: 'patients.search',
    announced: '2026-11-04',
    sunset: '2027-05-04',
    replacedBy: null,
    note: 'synthetic test entry only',
  };
  let s: CatalogStack;
  beforeAll(async () => {
    s = await startCatalogStack('api_change_control', ['patients.read', 'patients.write']);
  }, 300_000);
  afterAll(async () => {
    await s?.close();
  });

  it('REST: Deprecation, Sunset and Link headers on the deprecated operation only', async () => {
    const app = await buildApp({
      env: 'synthetic-test',
      logger: { level: 'error', stream: { write: () => undefined } },
      identity: s.issuer.verifierConfig,
      membership: s.membership,
      attempts: s.attemptSink,
      tenantTransactions: s.tenantTransactions,
      deprecations: [entry],
    });
    try {
      const token = await s.token('humanAll');
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const res = await app.inject({
        method: 'POST',
        url: '/v1/patients/search',
        headers,
        payload: JSON.stringify({ name: 'Synthetic' }),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers.deprecation).toBe('@1793750400');
      expect(res.headers.sunset).toBe('Tue, 04 May 2027 00:00:00 GMT');
      expect(res.headers.link).toBe('</docs/api/sunset-register.md>; rel="deprecation"');
      const other = await app.inject({
        method: 'POST',
        url: '/v1/patients',
        headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
        payload: JSON.stringify(patientBody('Synthetic Deprecation Person')),
      });
      expect(other.statusCode).toBe(201);
      expect(other.headers.deprecation).toBeUndefined();
      // A refusal of the deprecated operation carries the markers too, and is still audited.
      const seen = s.attempts.length;
      const denied = await app.inject({
        method: 'POST',
        url: '/v1/patients/search',
        headers: { ...headers, authorization: `Bearer ${await s.token('humanNone')}` },
        payload: JSON.stringify({ name: 'Synthetic' }),
      });
      expect([denied.statusCode, denied.headers.deprecation]).toStrictEqual([403, '@1793750400']);
      expect(s.attempts.slice(seen).map((a) => a.operation)).toContain('patients.search');
    } finally {
      await app.close();
    }
  });

  it('MCP: the tool description and every result carry the deprecation notice', async () => {
    const server = buildMcpServer({
      env: 'synthetic-test',
      identity: { ...s.issuer.verifierConfig, audience: MCP_AUDIENCE },
      restAudience: s.issuer.verifierConfig.audience,
      membership: s.membership,
      attempts: s.attemptSink,
      tenantTransactions: s.tenantTransactions,
      logger: { stream: { write: () => undefined } },
      deprecations: [entry],
    });
    const url = (await server.listen({ host: '127.0.0.1', port: 0 })).url;
    try {
      const r = await s.mcpAt(url, 'humanAll', 'patients_search', { name: 'Synthetic' });
      expect(r.isError).toBe(false);
      expect(r.meta?.deprecation).toStrictEqual({
        deprecated: true,
        sunset: '2027-05-04',
        replacedBy: null,
        notice: 'Deprecated since 2026-11-04; may be removed after 2027-05-04. No replacement exists.',
      });
      const tool = (await s.mcpListAt(url, 'humanAll')).find((t) => t.name === 'patients_search');
      expect(tool?.description).toContain('Deprecated since 2026-11-04');
    } finally {
      await server.close();
    }
  });
});
