// Verifies artifacts/evidence-manifest.json (see scripts/evidence.mjs). Exit 0 only if every check
// passes; otherwise prints one line per failure and exits 1. Checks: signature over the exact
// manifest bytes with the published per-run key and the key fingerprint bound in the manifest;
// shape and the required controls AS-01..AS-04; no certification claim; not expired; bound to the
// current HEAD; every artifact present with its recorded digest; the test summary digest; each
// control's tests passed after the commit time recorded by git (stale evidence fails); review claims
// only by an allowlisted reviewer (docs/assurance/reviewers.md) with a review time; no synthetic
// marker in the manifest.
//
// Usage: node scripts/evidence-verify.mjs [--root <dir>] [--now <iso>]
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const REQUIRED = ['AS-01', 'AS-02', 'AS-03', 'AS-04'];
const MARKER = ['SYNTHETIC_SECRET', '42'].join('_');

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--')),
  options: { root: { type: 'string' }, now: { type: 'string' } },
  strict: true,
});
const root = resolve(
  values.root ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
);
const now = values.now ? new Date(values.now) : new Date();
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const failures = [];
const finish = () => {
  if (failures.length) {
    for (const f of failures) process.stderr.write(`evidence-verify: FAIL ${f}\n`);
    process.exit(1);
  }
  process.stdout.write(
    'evidence-verify: ok (integrity and freshness only; controls remain unreviewed, not certified)\n',
  );
  process.exit(0);
};

const file = (p) => join(root, 'artifacts', p);
for (const p of ['evidence-manifest.json', 'evidence-manifest.sig', 'evidence-signing.pub']) {
  if (!existsSync(file(p))) failures.push(`missing artifacts/${p}`);
}
if (failures.length) finish();

const bytes = readFileSync(file('evidence-manifest.json'));
const pubDer = Buffer.from(readFileSync(file('evidence-signing.pub'), 'utf8').trim(), 'base64');
const sig = Buffer.from(readFileSync(file('evidence-manifest.sig'), 'utf8').trim(), 'base64');
let signatureOk = false;
try {
  signatureOk = verify(null, bytes, createPublicKey({ key: pubDer, format: 'der', type: 'spki' }), sig);
} catch {
  signatureOk = false;
}
if (!signatureOk) failures.push('signature does not verify: manifest or signature was changed after signing');

let m;
try {
  m = JSON.parse(bytes.toString('utf8'));
} catch {
  failures.push('manifest is not JSON');
  finish();
}
if (m.signing?.publicKeySha256 !== sha256(pubDer))
  failures.push('signing key does not match the key bound in the manifest');
if (m.kind !== 'cuspatlas-synthetic-evidence-manifest' || m.schemaVersion !== 2 || m.synthetic !== true) {
  failures.push('manifest kind/schemaVersion/synthetic flag invalid');
}
if (m.certification !== 'none' || typeof m.statement !== 'string' || !/not certification/.test(m.statement)) {
  failures.push('manifest must state that a passing test is not certification');
}
if (bytes.includes(MARKER)) failures.push('manifest contains the synthetic marker');

const expires = new Date(m.expiresAt);
if (Number.isNaN(expires.getTime()) || expires <= now) failures.push(`manifest expired at ${m.expiresAt}`);

let head = null;
let commitTime = null;
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  commitTime = new Date(
    execFileSync('git', ['show', '-s', '--format=%cI', m.commit], { cwd: root, encoding: 'utf8' }).trim(),
  );
} catch {
  failures.push('manifest commit is not a commit of this repository');
}
if (head && m.commit !== head)
  failures.push(`manifest is bound to ${String(m.commit).slice(0, 12)}, HEAD is ${head.slice(0, 12)}`);

if (m.testSummary?.path) {
  const p = resolve(root, m.testSummary.path);
  if (!existsSync(p)) failures.push(`test summary ${m.testSummary.path} is missing`);
  else if (sha256(readFileSync(p)) !== m.testSummary.sha256) failures.push('test summary digest mismatch');
} else failures.push('manifest has no test summary');

const reviewers = new Set();
const reviewersPath = join(root, 'docs/assurance/reviewers.md');
if (existsSync(reviewersPath)) {
  const text = readFileSync(reviewersPath, 'utf8');
  const section = text.split(/^## Allowlist\s*$/m)[1] ?? '';
  for (const line of section.split(/\r?\n/)) {
    const r = /^- `([a-z0-9][a-z0-9._-]{1,63})`/.exec(line);
    if (r) reviewers.add(r[1]);
  }
}

const controls = Array.isArray(m.controls) ? m.controls : [];
for (const id of REQUIRED) {
  if (!controls.some((c) => c.controlId === id)) failures.push(`required control ${id} is missing`);
}
for (const c of controls) {
  const id = c.controlId;
  for (const k of ['owner', 'scope', 'requirement', 'testRunAt', 'expiresAt']) {
    if (typeof c[k] !== 'string' || c[k] === '') failures.push(`${id}: ${k} missing`);
  }
  if (c.commit !== m.commit) failures.push(`${id}: bound to another commit`);
  if (c.result !== 'passed') failures.push(`${id}: result is ${c.result}`);
  const ran = new Date(c.testRunAt);
  if (Number.isNaN(ran.getTime())) failures.push(`${id}: testRunAt invalid`);
  else if (commitTime && ran < commitTime)
    failures.push(`${id}: stale evidence, tests ran before the commit time`);
  const cexp = new Date(c.expiresAt);
  if (Number.isNaN(cexp.getTime()) || cexp <= now) failures.push(`${id}: evidence expired`);
  if (!Array.isArray(c.tests) || c.tests.length === 0) failures.push(`${id}: no tests`);
  for (const t of c.tests ?? []) {
    if (t.status !== 'passed' || !(t.count > 0)) failures.push(`${id}: test file ${t.file} ${t.status}`);
  }
  if (!Array.isArray(c.artifacts) || c.artifacts.length === 0) failures.push(`${id}: no artifacts`);
  for (const a of c.artifacts ?? []) {
    const p = join(root, a.path);
    if (!existsSync(p)) failures.push(`${id}: artifact ${a.path} missing`);
    else if (sha256(readFileSync(p)) !== a.sha256) failures.push(`${id}: artifact ${a.path} digest mismatch`);
  }
  if (c.reviewStatus === 'certified') {
    failures.push(`${id}: claims certified; a test pass or a review is never a certification`);
  } else if (c.reviewStatus === 'reviewed') {
    if (typeof c.reviewer !== 'string' || typeof c.reviewedAt !== 'string') {
      failures.push(`${id}: reviewed without reviewer and reviewedAt`);
    } else {
      if (!reviewers.has(c.reviewer)) failures.push(`${id}: reviewer is not in docs/assurance/reviewers.md`);
      const at = new Date(c.reviewedAt);
      if (Number.isNaN(at.getTime()) || at < ran || at > now) failures.push(`${id}: reviewedAt invalid`);
    }
  } else if (c.reviewStatus !== 'unreviewed') {
    failures.push(`${id}: unknown reviewStatus`);
  }
}
finish();
