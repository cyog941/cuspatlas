// Populates artifacts/evidence-manifest.json with the AS-01..AS-04 synthetic controls from
// docs/assurance/controls.json, binds them to the commit, the reduced test summary and artifact
// digests, and signs the manifest with an Ed25519 key generated for this run only.
//
// Outputs (gitignored artifacts/): evidence-manifest.json, evidence-manifest.sig (base64 signature
// over the exact manifest bytes), evidence-signing.pub (base64 DER SPKI public key; not PEM so the
// key-material tripwire stays meaningful). The private key exists only in memory and is never written.
// The signature proves the manifest was not changed after this run; it does not prove who ran it
// (no long-lived release key exists yet) and it never makes a control certified.
//
// Usage: node scripts/evidence.mjs [--root <dir>] [--summary <path>] [--now <iso>]
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const MAX_AGE_DAYS = 30;
const STATEMENT =
  'Synthetic development evidence only. A passing test is evidence for review, not certification: no control in this manifest is certified, audited, approved or compliant, and nothing here authorizes PHI or deployment.';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--')),
  options: { root: { type: 'string' }, summary: { type: 'string' }, now: { type: 'string' } },
  strict: true,
});
const root = resolve(
  values.root ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fail = (msg) => {
  process.stderr.write(`evidence: ${msg}\n`);
  process.exit(1);
};

const now = values.now ? new Date(values.now) : new Date();
if (Number.isNaN(now.getTime())) fail('--now is not a date');
const commit = git('rev-parse', 'HEAD');
const commitTime = new Date(git('show', '-s', '--format=%cI', commit)).toISOString();
const worktreeClean = git('status', '--porcelain', '--untracked-files=no') === '';

const registry = JSON.parse(readFileSync(join(root, 'docs/assurance/controls.json'), 'utf8'));
const summaryPath = values.summary ?? 'artifacts/test-summary.json';
const summaryAbs = resolve(root, summaryPath);
if (!existsSync(summaryAbs))
  fail(`test summary ${summaryPath} not found (run the test suite with the JSON reporter first)`);
const summary = JSON.parse(readFileSync(summaryAbs, 'utf8'));
if (typeof summary.testRunAt !== 'string') fail('test summary has no testRunAt');
const byFile = new Map((summary.files ?? []).map((f) => [f.file, f]));

const expiresAt = new Date(now.getTime() + MAX_AGE_DAYS * 86_400_000).toISOString();
const controls = registry.controls.map((c) => {
  const artifacts = c.artifacts.map((p) => {
    const abs = join(root, p);
    if (!existsSync(abs)) fail(`control ${c.controlId}: artifact ${p} is missing`);
    return { path: p, sha256: sha256(readFileSync(abs)) };
  });
  const tests = c.tests.map((file) => {
    const r = byFile.get(file);
    return { file, count: r ? r.tests : 0, status: r ? r.status : 'missing' };
  });
  const passed = summary.success === true && tests.every((t) => t.status === 'passed' && t.count > 0);
  return {
    controlId: c.controlId,
    owner: c.owner,
    scope: c.scope,
    requirement: c.requirement,
    artifacts,
    tests,
    testRunAt: summary.testRunAt,
    result: passed ? 'passed' : 'failed',
    commit,
    reviewStatus: 'unreviewed',
    expiresAt,
    freshness: { maxAgeDays: MAX_AGE_DAYS, generatedAt: now.toISOString() },
  };
});

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubDer = publicKey.export({ type: 'spki', format: 'der' });
const manifest = {
  schemaVersion: 2,
  kind: 'cuspatlas-synthetic-evidence-manifest',
  synthetic: true,
  statement: STATEMENT,
  certification: 'none',
  commit,
  commitTime,
  worktreeClean,
  generatedAt: now.toISOString(),
  expiresAt,
  signing: {
    algorithm: 'Ed25519',
    publicKeySha256: sha256(pubDer),
    keyLifetime: 'generated for this run; private key held in memory only and discarded',
  },
  testSummary: {
    path: summaryPath,
    sha256: sha256(readFileSync(summaryAbs)),
    testRunAt: summary.testRunAt,
    numTotalTests: summary.numTotalTests,
    numPassedTests: summary.numPassedTests,
    success: summary.success === true,
  },
  controls,
};
const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
const signature = sign(null, bytes, privateKey);
const out = join(root, 'artifacts');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'evidence-manifest.json'), bytes);
writeFileSync(join(out, 'evidence-manifest.sig'), `${signature.toString('base64')}\n`);
writeFileSync(join(out, 'evidence-signing.pub'), `${pubDer.toString('base64')}\n`);
const failed = controls.filter((c) => c.result !== 'passed').map((c) => c.controlId);
process.stdout.write(
  `evidence: ${controls.length} controls at ${commit.slice(0, 12)} (${failed.length ? `failed: ${failed.join(', ')}` : 'all tests passed'}; review status unreviewed; not certified)${worktreeClean ? '' : ' [worktree has uncommitted changes]'}\n`,
);
