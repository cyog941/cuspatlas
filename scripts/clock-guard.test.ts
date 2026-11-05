import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLOCK_ALLOWLIST, type ClockAllowlistEntry } from './clock-allowlist';
import { findAppClockUses } from './clock-scan';

/**
 * Clock audit guard. Domain code takes current time from the database for any comparison with a
 * stored fact (packages/domain/src/clock.ts). Every application-clock read (`now` of the global `Date`
 * in any spelling, a bare `new Date()`; see scripts/clock-scan.ts, which reads the TypeScript AST) in
 * packages/domain, packages/db, packages/contracts, packages/client and apps/* outside tests must be an
 * audited entry of scripts/clock-allowlist.ts with its reason, keyed by file, enclosing function and
 * occurrence index (identical line text elsewhere cannot take an entry's place). A new read fails here
 * until it is moved to the database clock or audited and listed; an entry with no read fails too.
 */
const ROOT = resolve(import.meta.dirname, '..');
const SCANNED = [
  'packages/domain/src',
  'packages/db/src',
  'packages/contracts/src',
  'packages/client/src',
  ...appSources(),
];

function appSources(): string[] {
  return readdirSync(join(ROOT, 'apps'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `apps/${d.name}/src`);
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...sources(rel));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts'))
      out.push(rel);
  }
  return out;
}

type Key = Pick<ClockAllowlistEntry, 'file' | 'fn' | 'kind' | 'index'>;
const key = (u: Key) => `${u.file} :: ${u.fn} :: ${u.kind} #${u.index}`;

function appClockUses(): (Key & { line: number })[] {
  return SCANNED.flatMap((dir) =>
    sources(dir).flatMap((file) =>
      findAppClockUses(readFileSync(join(ROOT, file), 'utf8'), file).map((u) => ({ file, ...u })),
    ),
  );
}

describe('clock audit guard', () => {
  it('every application-clock read is an audited allowlist entry, and every entry still exists', () => {
    const listed = new Set(CLOCK_ALLOWLIST.map(key));
    const found = appClockUses();
    const unaudited = found.filter((u) => !listed.has(key(u))).map((u) => `${key(u)} (line ${u.line})`);
    const present = new Set(found.map(key));
    const stale = CLOCK_ALLOWLIST.filter((e) => !present.has(key(e))).map(key);
    expect({ unaudited, stale }).toStrictEqual({ unaudited: [], stale: [] });
    // Parses every scanned source file: allow for a loaded runner.
  }, 60_000);

  it('entries are unique and each states a class and a reason', () => {
    const keys = CLOCK_ALLOWLIST.map(key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of CLOCK_ALLOWLIST) {
      expect(e.reason, key(e)).toMatch(/^\([a-c]\) /);
      expect(e.reason.length, key(e)).toBeGreaterThan(20);
    }
  });
});

describe('clock scanner fixtures', () => {
  const kinds = (src: string) => findAppClockUses(src).map((u) => u.kind);
  it.each([
    ['Date.now()', 'if (expires <= Date.now()) throw expired();'],
    ['a Date.now reference', 'const clock = options.now ?? Date.now;'],
    ['element access', "const t = Date['now']();"],
    ['template element access', 'const t = Date[`now`]();'],
    ['destructuring', 'const { now } = Date;\nnow();'],
    ['renamed destructuring', 'const { now: tick } = Date;'],
    ['assignment destructuring', 'let now; ({ now } = Date);'],
    ['an alias', 'const D = Date;\nexport const f = () => D.now();'],
    ['an alias chain', 'const A = Date; const B = A; B.now();'],
    ['globalThis', 'globalThis.Date.now();'],
    ['parentheses and assertions', '((Date) as DateConstructor).now();'],
    ['split across lines with comments', 'const t = Date /* x */\n  // y\n  .now();'],
  ])('finds Date.now through %s', (_, src) => {
    expect(kinds(src)).toStrictEqual(['Date.now']);
  });

  it.each([
    ['new Date()', 'const at = new Date();'],
    ['new Date without parentheses', 'const at = new Date;'],
    ['new globalThis.Date()', 'const at = new globalThis.Date();'],
    ["new globalThis['Date']()", "const at = new globalThis['Date']();"],
    ['new (Date)()', 'const at = new (Date)();'],
    ['an alias', 'const D = Date;\nconst at = new D();'],
    ['across lines with a comment', 'const at = new Date(\n  // nothing\n);'],
  ])('finds a bare clock through %s', (_, src) => {
    expect(kinds(src)).toStrictEqual(['new Date()']);
  });

  it('ignores comments, strings, other receivers and dated constructors', () => {
    expect(
      kinds(
        [
          '// Date.now() and new Date() in a comment',
          '/* new Date() */',
          "const s = 'Date.now() new Date()';",
          'const at = new Date(row.at);',
          'const t = new Date(0, 1);',
          'const n = clock.now();',
          'const p = performance.now();',
          'const x = { now: 1 }.now;',
          'const at = await databaseNow(tx);',
        ].join('\n'),
      ),
    ).toStrictEqual([]);
  });

  it('keys each read by enclosing function and occurrence, not by line text', () => {
    const src = [
      'export function outer() {',
      '  const a = Date.now();',
      '  const inner = () => Date.now();',
      '  return [a, inner(), Date.now()];',
      '}',
      'class Clock { tick() { return new Date(); } }',
      'export const top = Date.now();',
    ].join('\n');
    expect(findAppClockUses(src).map(({ fn, kind, index }) => ({ fn, kind, index }))).toStrictEqual([
      { fn: 'outer', kind: 'Date.now', index: 0 },
      { fn: 'outer.inner', kind: 'Date.now', index: 0 },
      { fn: 'outer', kind: 'Date.now', index: 1 },
      { fn: 'Clock.tick', kind: 'new Date()', index: 0 },
      { fn: '<module>', kind: 'Date.now', index: 0 },
    ]);
  });
});
