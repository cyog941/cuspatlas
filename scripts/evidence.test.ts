import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * AS-01/AS-04 evidence manifest: scripts/evidence.mjs and scripts/evidence-verify.mjs run against a
 * throwaway git repository with a minimal control registry, then every failure mode is provoked.
 */

const SCRIPTS = resolve(import.meta.dirname);
const MARKER = ['SYNTHETIC_SECRET', '42'].join('_');
let root: string;

const run = (script: string, ...args: string[]) =>
  spawnSync(process.execPath, [join(SCRIPTS, script), '--root', root, ...args], { encoding: 'utf8' });
const generate = (...args: string[]) => run('evidence.mjs', ...args);
const verifyRun = (...args: string[]) => run('evidence-verify.mjs', ...args);
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=synthetic', '-c', 'user.email=synthetic@example.invalid', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
const write = (p: string, text: string) => {
  mkdirSync(join(root, p, '..'), { recursive: true });
  writeFileSync(join(root, p), text);
};
const manifestPath = () => join(root, 'artifacts', 'evidence-manifest.json');
const manifest = () => JSON.parse(readFileSync(manifestPath(), 'utf8'));
const summary = (over: Record<string, unknown> = {}, status = 'passed') =>
  write(
    'artifacts/test-summary.json',
    `${JSON.stringify({
      schemaVersion: 1,
      success: status === 'passed',
      testRunAt: new Date().toISOString(),
      numTotalTests: 3,
      numPassedTests: status === 'passed' ? 3 : 2,
      files: [{ file: 'x.test.ts', status, tests: 3 }],
      ...over,
    })}\n`,
  );

/** Re-signs an edited manifest with a fresh key, as anyone able to run the generator could. */
function resign(edit: (m: Record<string, unknown>) => void): void {
  const m = manifest();
  edit(m);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  m.signing.publicKeySha256 = createHash('sha256').update(der).digest('hex');
  const bytes = Buffer.from(`${JSON.stringify(m, null, 2)}\n`);
  writeFileSync(manifestPath(), bytes);
  writeFileSync(
    join(root, 'artifacts', 'evidence-manifest.sig'),
    sign(null, bytes, privateKey).toString('base64'),
  );
  writeFileSync(join(root, 'artifacts', 'evidence-signing.pub'), der.toString('base64'));
}
const controls = (m: Record<string, unknown>) => m.controls as Record<string, unknown>[];

function expectFail(r: ReturnType<typeof verifyRun>, pattern: RegExp): void {
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(pattern);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cuspatlas-evidence-'));
  git('init', '-q');
  write('.gitignore', 'artifacts/\n');
  write('a.txt', 'artifact one\n');
  write(
    'docs/assurance/controls.json',
    JSON.stringify({
      schemaVersion: 1,
      controls: ['AS-01', 'AS-02', 'AS-03', 'AS-04'].map((controlId) => ({
        controlId,
        owner: 'security owner',
        scope: 'synthetic fixture',
        requirement: 'fixture requirement',
        artifacts: ['a.txt', 'artifacts/test-summary.json'],
        tests: ['x.test.ts'],
      })),
    }),
  );
  write(
    'docs/assurance/reviewers.md',
    '# Reviewers\n\n## Allowlist\n\n- `alice-review` — security owner, 2026-11-04\n',
  );
  git('add', '.');
  git('commit', '-q', '-m', 'fixture');
  summary();
  const g = generate();
  expect(g.status, g.stderr).toBe(0);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('evidence manifest', () => {
  it('is generated with AS-01..AS-04, unreviewed, not certified, signed, and verifies', () => {
    const m = manifest();
    expect(controls(m).map((c) => c.controlId)).toEqual(['AS-01', 'AS-02', 'AS-03', 'AS-04']);
    for (const c of controls(m)) {
      expect(c).toMatchObject({ reviewStatus: 'unreviewed', result: 'passed', owner: 'security owner' });
      expect(c.tests).toEqual([{ file: 'x.test.ts', count: 3, status: 'passed' }]);
      expect(Date.parse(c.expiresAt as string) - Date.parse(m.generatedAt)).toBe(30 * 86_400_000);
    }
    expect(m.certification).toBe('none');
    expect(m.statement).toMatch(/passing test is evidence for review, not certification/);
    expect(readFileSync(join(root, 'artifacts', 'evidence-signing.pub'), 'utf8')).not.toMatch(
      /PRIVATE|BEGIN/,
    );
    const r = verifyRun();
    expect(r.status, r.stderr).toBe(0);
  });

  it('fails on a missing artifact', () => {
    unlinkSync(join(root, 'a.txt'));
    expectFail(verifyRun(), /artifact a\.txt missing/);
  });

  it('fails on a tampered artifact (digest mismatch)', () => {
    writeFileSync(join(root, 'a.txt'), 'artifact one changed\n');
    expectFail(verifyRun(), /artifact a\.txt digest mismatch/);
  });

  it('fails on a tampered manifest and on a bad or swapped signature', () => {
    const original = readFileSync(manifestPath(), 'utf8');
    writeFileSync(manifestPath(), original.replace('"owner": "security owner"', '"owner": "someone else"'));
    expectFail(verifyRun(), /signature does not verify/);
    writeFileSync(manifestPath(), original);
    expect(verifyRun().status).toBe(0);
    const other = generateKeyPairSync('ed25519');
    writeFileSync(
      join(root, 'artifacts', 'evidence-manifest.sig'),
      sign(null, Buffer.from(original), other.privateKey).toString('base64'),
    );
    expectFail(verifyRun(), /signature does not verify/);
    writeFileSync(
      join(root, 'artifacts', 'evidence-signing.pub'),
      other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    );
    expectFail(verifyRun(), /signing key does not match the key bound in the manifest/);
  });

  it('fails when expired', () => {
    expectFail(verifyRun('--now', new Date(Date.now() + 31 * 86_400_000).toISOString()), /expired/);
  });

  it('fails when the tests ran before the commit (stale evidence)', () => {
    summary({ testRunAt: '2000-01-01T00:00:00.000Z' });
    expect(generate().status).toBe(0);
    expectFail(verifyRun(), /AS-01: stale evidence, tests ran before the commit time/);
  });

  it('fails when HEAD moved after the evidence was generated', () => {
    write('b.txt', 'later change\n');
    git('add', 'b.txt');
    git('commit', '-q', '-m', 'later');
    expectFail(verifyRun(), /manifest is bound to/);
  });

  it('fails when a listed test file failed or is missing', () => {
    summary({}, 'failed');
    expect(generate().status).toBe(0);
    expect(controls(manifest())[0]?.result).toBe('failed');
    expectFail(verifyRun(), /AS-01: result is failed/);
  });

  it('refuses forged or incomplete review claims and any certification claim', () => {
    const at = new Date().toISOString();
    resign((m) => Object.assign(controls(m)[0] as object, { reviewStatus: 'reviewed' }));
    expectFail(verifyRun(), /AS-01: reviewed without reviewer and reviewedAt/);
    resign((m) =>
      Object.assign(controls(m)[0] as object, {
        reviewStatus: 'reviewed',
        reviewer: 'mallory',
        reviewedAt: at,
      }),
    );
    expectFail(verifyRun(), /AS-01: reviewer is not in docs\/assurance\/reviewers\.md/);
    resign((m) => Object.assign(controls(m)[1] as object, { reviewStatus: 'certified' }));
    expectFail(verifyRun(), /AS-02: claims certified/);
    // Positive control: an allowlisted reviewer with a review time passes.
    resign((m) => {
      Object.assign(controls(m)[1] as object, { reviewStatus: 'unreviewed' });
      Object.assign(controls(m)[0] as object, {
        reviewStatus: 'reviewed',
        reviewer: 'alice-review',
        reviewedAt: new Date(Date.now() + 1000).toISOString(),
      });
    });
    const ok = verifyRun('--now', new Date(Date.now() + 5000).toISOString());
    expect(ok.status, ok.stderr).toBe(0);
  });

  it('fails when a required control is dropped or the statement or the marker changes', () => {
    resign((m) => {
      m.controls = controls(m).filter((c) => c.controlId !== 'AS-03');
    });
    expectFail(verifyRun(), /required control AS-03 is missing/);
    resign((m) => {
      m.statement = 'All controls certified.';
    });
    expectFail(verifyRun(), /not certification/);
    resign((m) => {
      (controls(m)[0] as Record<string, unknown>).scope = MARKER;
    });
    expectFail(verifyRun(), /contains the synthetic marker/);
  });

  it('fails when signature files are missing', () => {
    unlinkSync(join(root, 'artifacts', 'evidence-manifest.sig'));
    expectFail(verifyRun(), /missing artifacts\/evidence-manifest\.sig/);
  });
});
