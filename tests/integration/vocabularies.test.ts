import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VOCABULARIES, VOCABULARY_MODULES } from '../../packages/contracts/src/vocabularies';
import { type AppointmentHarness, openAppointmentHarness } from './support/appointment-fixtures';
import { openTestDatabase, type TestDatabase } from './support/db';

/**
 * A20 / OR-02. Every value of every state CHECK constraint (a column named `state`, `status` or ending
 * in `_state`/`_status` in the cuspatlas schema, read from the live migrated catalog) and every
 * derived state enum a registry names (`schema:<file>:<Def>.<property>`) has exactly one vocabulary
 * entry with a non-empty plain label. A new CHECK value or a new state column without an entry fails CI.
 */
let db: TestDatabase;
let checks: Map<string, Set<string>>;
const STATE_COLUMN = /(^|_)(state|status)$/;

beforeAll(async () => {
  db = await openTestDatabase('vocabularies');
  const { rows } = await db.admin.query<{ tbl: string; def: string }>(
    `SELECT c.conrelid::regclass::text AS tbl, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
     JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.contype = 'c' AND n.nspname = 'cuspatlas'`,
  );
  checks = new Map();
  for (const { tbl, def } of rows) {
    for (const m of def.matchAll(/\(\(?([a-z_]+)\)?(?:::text)? = ANY \(\(?ARRAY\[([^\]]*)\]/g)) {
      const column = m[1] as string;
      if (!STATE_COLUMN.test(column)) continue;
      const key = `${tbl.replace(/^cuspatlas\./, '')}.${column}`;
      const set = checks.get(key) ?? new Set<string>();
      for (const v of (m[2] as string).matchAll(/'([^']*)'/g)) set.add(v[1] as string);
      checks.set(key, set);
    }
  }
});
afterAll(async () => {
  await db?.close();
});

const schemaEnum = (source: string): string[] => {
  const [, file, path] = source.split(':') as [string, string, string];
  const [def, ...props] = path.split('.');
  const defs = JSON.parse(
    readFileSync(resolve(__dirname, `../../packages/contracts/src/${file}.schema.json`), 'utf8'),
  ).$defs as Record<string, { enum?: string[]; properties?: Record<string, unknown> }>;
  let node = defs[def as string] as { enum?: string[]; properties?: Record<string, unknown> } | undefined;
  for (const p of props) node = node?.properties?.[p] as typeof node;
  return node?.enum ?? [];
};

describe('A20 / OR-02 state vocabularies', () => {
  it('the live catalog has state CHECK constraints to cover', () => {
    expect(checks.size).toBeGreaterThanOrEqual(60);
  });

  it('every state CHECK column belongs to exactly one vocabulary, and every source still exists', () => {
    const owners = new Map<string, string[]>();
    for (const v of VOCABULARIES.values())
      for (const s of VOCABULARY_MODULES.flatMap((m) => m.vocabularies).find((d) => d.name === v.name)
        ?.sources ?? [])
        owners.set(s, [...(owners.get(s) ?? []), v.name]);
    for (const column of checks.keys()) expect(owners.get(column), column).toHaveLength(1);
    for (const source of owners.keys()) {
      if (source.startsWith('schema:')) expect(schemaEnum(source).length, source).toBeGreaterThan(0);
      else expect(checks.has(source), `${source} is no longer a state CHECK column`).toBe(true);
    }
  });

  it('every CHECK and enum value has exactly one entry with a label; no vocabulary invents a state', () => {
    for (const def of VOCABULARY_MODULES.flatMap((m) => m.vocabularies)) {
      const allowed = new Set(
        def.sources.flatMap((s) => (s.startsWith('schema:') ? schemaEnum(s) : [...(checks.get(s) ?? [])])),
      );
      const codes = def.entries.map((e) => e.code);
      for (const code of allowed)
        expect(
          codes.filter((c) => c === code),
          `${def.name}.${code}`,
        ).toHaveLength(1);
      expect(
        codes.filter((c) => !allowed.has(c)),
        `${def.name} entries with no source value`,
      ).toEqual([]);
      for (const e of def.entries) {
        expect(e.label.trim().length, `${def.name}.${e.code} label`).toBeGreaterThan(0);
        expect(e.label, `${def.name}.${e.code} is a label, not a code`).not.toMatch(/_/);
        expect(['lifecycle', 'presence', 'exception', 'financial', 'clinical']).toContain(e.category);
      }
      expect(new Set(def.entries.map((e) => e.shortCode)).size, `${def.name} shortCodes`).toBe(
        def.entries.length,
      );
      // Filter sentinels never appear as states.
      for (const sentinel of ['all', 'any', 'none']) expect(codes, def.name).not.toContain(sentinel);
    }
  });

  it('vocabulary names are unique and every module registry is versioned', () => {
    const names = VOCABULARY_MODULES.flatMap((m) => m.vocabularies.map((v) => v.name));
    expect(new Set(names).size).toBe(names.length);
    for (const m of VOCABULARY_MODULES)
      expect(m.version).toMatch(new RegExp(`^${m.module}-state-labels\\.[0-9]+$`));
  });
});

describe('A20 / OR-02 vocabulary resource (REST GET /v1/vocabularies, MCP vocabularies_get)', () => {
  let h: AppointmentHarness;
  let vdb: TestDatabase;
  beforeAll(async () => {
    vdb = await openTestDatabase('vocabularies_api');
    h = await openAppointmentHarness(vdb, { mcp: true, pool: 4 });
  });
  afterAll(async () => {
    await h?.close();
    await vdb?.close();
  });

  it('lists every vocabulary with the envelope and reads one by name; REST and MCP agree', async () => {
    const list = h.ok<{ data: { name: string }[]; envelope: { count: { exact: number } } }>(
      await h.call('a1', 'GET', '/v1/vocabularies'),
    );
    expect(list.data.map((v) => v.name)).toStrictEqual([...VOCABULARIES.keys()].sort());
    expect(list.envelope.count).toStrictEqual({ exact: VOCABULARIES.size });
    const claim = h.ok<{ data: { version: string; entries: { code: string; label: string }[] } }>(
      await h.call('a1', 'GET', '/v1/vocabularies/claim'),
    );
    expect(claim.data.version).toBe('billing-state-labels.1');
    expect(claim.data.entries.find((e) => e.code === 'payer_rejected')?.label).toBe('Rejected by the payer');
    const m = await h.mcp('a1', 'vocabularies_get', { name: 'claim' });
    expect(m.body).toStrictEqual(claim);
    const ml = await h.mcp('svcA1', 'vocabularies_list', {});
    expect((ml.body as { data: unknown[] }).data).toHaveLength(VOCABULARIES.size);
  });

  it('negative: unknown name is 404, revoked membership and foreign tenant tokens are refused', async () => {
    expect((await h.call('a1', 'GET', '/v1/vocabularies/not_a_vocabulary')).statusCode).toBe(404);
    expect((await h.call('a2', 'GET', '/v1/vocabularies')).statusCode).toBe(403);
    expect((await h.call('a2', 'GET', '/v1/vocabularies/claim')).statusCode).toBe(403);
  });
});

describe('A20 / OR-02 responses carrying a state code state the vocabulary version', () => {
  it('every vocabulary-bearing operation is in the catalog and its success schema declares `vocabularies`', async () => {
    const { VOCABULARY_BEARING } = await import('../../packages/contracts/src/vocabularies');
    const ops = (await import('../../packages/contracts/src/catalog/operations.json')).default as {
      operation: string;
      rest?: { successSchema?: string };
    }[];
    for (const [operation, names] of Object.entries(VOCABULARY_BEARING)) {
      for (const n of names) expect(VOCABULARIES.has(n), `${operation} ${n}`).toBe(true);
      const op = ops.find((o) => o.operation === operation);
      expect(op, operation).toBeDefined();
      const [file, def] = (op?.rest?.successSchema ?? '').split(':') as [string, string];
      const defs = JSON.parse(
        readFileSync(resolve(__dirname, `../../packages/contracts/src/${file}.schema.json`), 'utf8'),
      ).$defs;
      expect(defs[def]?.properties?.vocabularies, operation).toStrictEqual({
        $ref: '#/$defs/VocabularyVersions',
      });
    }
  });
});
