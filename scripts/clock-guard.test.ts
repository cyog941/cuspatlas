import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLOCK_ALLOWLIST } from './clock-allowlist';

/**
 * Clock audit guard. Domain code takes current time from the database for any comparison with a
 * stored fact (packages/domain/src/clock.ts). Every application-clock read (`Date.now`, a bare
 * `new Date()`) in packages/domain, packages/db and apps/* outside tests must be an audited entry of
 * scripts/clock-allowlist.ts with its reason; a new one fails here until it is moved to the database
 * clock or audited and listed. An entry whose line no longer exists fails too, so the list stays exact.
 */
const ROOT = resolve(import.meta.dirname, '..');
const SCANNED = ['packages/domain/src', 'packages/db/src', ...appSources()];
const APP_CLOCK = /\bDate\.now\b|\bnew Date\(\s*\)/;

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
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(rel);
  }
  return out;
}

/** Each application-clock read as `file` + its trimmed source line (one entry per occurrence). */
function appClockUses(): { file: string; code: string }[] {
  const uses: { file: string; code: string }[] = [];
  for (const dir of SCANNED) {
    for (const file of sources(dir)) {
      for (const line of readFileSync(join(ROOT, file), 'utf8').split(/\r?\n/)) {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue;
        const n = code.split(APP_CLOCK).length - 1;
        for (let i = 0; i < n; i += 1)
          uses.push({ file: relative(ROOT, join(ROOT, file)).split('\\').join('/'), code });
      }
    }
  }
  return uses;
}

const key = (u: { file: string; code: string }) => `${u.file} :: ${u.code}`;

describe('clock audit guard', () => {
  it('every application-clock read is an audited allowlist entry, and every entry still exists', () => {
    const remaining = new Map<string, number>();
    for (const e of CLOCK_ALLOWLIST) remaining.set(key(e), (remaining.get(key(e)) ?? 0) + 1);
    const unaudited: string[] = [];
    for (const u of appClockUses()) {
      const left = remaining.get(key(u)) ?? 0;
      if (left === 0) unaudited.push(key(u));
      else remaining.set(key(u), left - 1);
    }
    const stale = [...remaining].filter(([, n]) => n > 0).map(([k]) => k);
    expect({ unaudited, stale }).toStrictEqual({ unaudited: [], stale: [] });
  });

  it('every allowlist entry states a class and a reason', () => {
    for (const e of CLOCK_ALLOWLIST) {
      expect(e.reason.length, key(e)).toBeGreaterThan(20);
    }
  });

  it('detects a bare application clock read', () => {
    expect(APP_CLOCK.test('if (expires <= Date.now()) throw expired();')).toBe(true);
    expect(APP_CLOCK.test('const clock = options.now ?? Date.now;')).toBe(true);
    expect(APP_CLOCK.test('const at = new Date();')).toBe(true);
    expect(APP_CLOCK.test('const at = new Date(row.at);')).toBe(false);
    expect(APP_CLOCK.test('const at = await databaseNow(tx);')).toBe(false);
  });
});
