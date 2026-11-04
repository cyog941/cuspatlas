import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural guard (ADR 0008): no floating-point value appears on a money path. Every billing source
 * file, the shared Money helpers, the billing contract, transports and migrations are scanned with
 * comments removed; a match fails the build. Money is integer minor units plus explicit currency.
 */
const ROOT = resolve(__dirname, '../../../..');
const TS_FORBIDDEN =
  /\bparseFloat\b|\.toFixed\s*\(|\.toPrecision\s*\(|\bMath\.(round|floor|ceil|trunc|fround)\b|\bNumber\.parseFloat\b|\bFloat(32|64)Array\b/;
const SQL_FORBIDDEN = /\b(double\s+precision|real|float4|float8|float|money)\b(?!_)/i;

const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const stripSql = (s: string) => s.replace(/--.*$/gm, '');

function files(dir: string, test: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...files(rel, test));
    else if (test(e.name)) out.push(rel);
  }
  return out;
}

const tsSources = () => [
  ...files('packages/domain/src/billing', (n) => n.endsWith('.ts') && !n.endsWith('.test.ts')),
  ...files('packages/domain/src/rcm', (n) => n.endsWith('.ts') && !n.endsWith('.test.ts')),
  'packages/contracts/src/money.ts',
  'packages/contracts/src/billing.ts',
  ...files('apps/api/src/routes', (n) => n.startsWith('billing')),
  ...files('apps/mcp/src/tools', (n) => n.startsWith('billing')),
];
const sqlSources = () => files('supabase/migrations', (n) => n.includes('billing'));

describe('no floating-point arithmetic on money paths', () => {
  it('scans the billing sources (the guard is not vacuous)', () => {
    const ts = tsSources();
    expect(ts).toContain('packages/contracts/src/money.ts');
    expect(ts).toContain('packages/domain/src/billing/journal.ts');
    expect(ts).toContain('packages/domain/src/rcm/coverage.ts');
    expect(sqlSources().length).toBeGreaterThan(0);
  });

  it('no billing TypeScript uses float parsing, float formatting or float rounding', () => {
    for (const f of tsSources()) {
      const lines = stripTs(readFileSync(join(ROOT, f), 'utf8')).split('\n');
      lines.forEach((line, i) => {
        expect([f, i + 1, TS_FORBIDDEN.test(line)]).toStrictEqual([f, i + 1, false]);
      });
    }
  });

  it('no billing migration declares a floating-point or currency-formatted column', () => {
    for (const f of sqlSources()) {
      const lines = stripSql(readFileSync(join(ROOT, f), 'utf8')).split('\n');
      lines.forEach((line, i) => {
        expect([f, i + 1, SQL_FORBIDDEN.test(line)]).toStrictEqual([f, i + 1, false]);
      });
    }
  });

  it('the money JSON contract only admits integers for minor units', () => {
    const schema = JSON.parse(readFileSync(join(ROOT, 'packages/contracts/src/billing.schema.json'), 'utf8'));
    for (const name of ['MinorUnits', 'PositiveMinorUnits']) {
      expect([name, schema.$defs[name].type]).toStrictEqual([name, 'integer']);
    }
  });
});
