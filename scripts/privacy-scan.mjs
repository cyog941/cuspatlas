// Privacy scan: fails (exit 1, file:line) when tracked files, or any file/directory passed as an
// argument (for example CI artifacts), contain the synthetic marker outside its allowlist,
// key material, JWT-looking strings, service-role-like keys, credentialed database URLs, or the
// development project reference outside its allowlist. Prints locations only, never matched text.
// Usage: node scripts/privacy-scan.mjs [extra file or directory ...]
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const MARKER = ['SYNTHETIC_SECRET', '42'].join('_');
const PROJECT_REF = ['pfnuigldoshdldetkaqk'].join('');

// Repository-relative, forward-slash. A trailing "/**" means a whole directory tree.
const MARKER_ALLOW = [
  'tests/**',
  'docs/execution/**',
  'docs/superpowers/**',
  'docs/ACCEPTANCE-SCENARIOS.md',
  'scripts/privacy-scan.mjs',
  'packages/contracts/src/*.test.ts',
];
const escapeRe = (t) => t.replace(/[.+^${}()|[\]\\]/g, (c) => `\\${c}`);
const REF_ALLOW = [
  'docs/SETUP.md',
  'docs/DEEPSEEK-HANDOFF.md',
  'docs/execution/**',
  'docs/superpowers/**',
  'scripts/privacy-scan.mjs',
];

function allowed(rel, list) {
  return list.some((p) => {
    if (p.endsWith('/**')) return rel.startsWith(p.slice(0, -2));
    if (p.includes('*')) {
      const re = new RegExp(`^${p.split('*').map(escapeRe).join('[^/]*')}$`);
      return re.test(rel);
    }
    return rel === p;
  });
}

const RULES = [
  { id: 'private-key-material', re: new RegExp(['-----', 'BEGIN'].join('')) },
  { id: 'jwt-like-string', re: /eyJ[A-Za-z0-9_-]{20,}\./ },
  {
    id: 'service-role-like-key',
    re: /sb_secret_[A-Za-z0-9_-]{20,}|SERVICE_ROLE_KEY\s*[=:]\s*['"]?[A-Za-z0-9._-]{20,}/,
  },
  { id: 'credentialed-database-url', re: /postgres(?:ql)?:\/\/[^\s:@/'"`]+:[^\s@/'"`]+@/ },
  { id: 'dev-project-ref', re: new RegExp(PROJECT_REF), allow: REF_ALLOW },
  { id: 'synthetic-marker', re: new RegExp(MARKER), allow: MARKER_ALLOW },
];

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const hits = [];

function scanFile(abs, rel, explicit) {
  let buf;
  try {
    buf = readFileSync(abs);
  } catch {
    return;
  }
  if (buf.includes(0)) return; // binary
  const lines = buf.toString('utf8').split(/\r?\n/);
  for (const rule of RULES) {
    // Explicit arguments (artifacts, fixtures) have no allowlist: nothing may leave via an artifact.
    if (!explicit && rule.allow && allowed(rel, rule.allow)) continue;
    for (let i = 0; i < lines.length; i++) {
      if (rule.re.test(lines[i])) hits.push(`${rel}:${i + 1}: ${rule.id}`);
    }
  }
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.push(p);
  }
}

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0')
  .filter(Boolean);
for (const rel of tracked) scanFile(join(root, rel), rel.split(sep).join('/'), false);

let extraCount = 0;
for (const arg of process.argv.slice(2)) {
  const abs = resolve(arg);
  const st = statSync(abs);
  const files = [];
  if (st.isDirectory()) walk(abs, files);
  else files.push(abs);
  for (const f of files) {
    extraCount++;
    scanFile(f, relative(process.cwd(), f).split(sep).join('/') || f, true);
  }
}

if (hits.length > 0) {
  process.stderr.write(`privacy-scan: ${hits.length} finding(s)\n${hits.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`privacy-scan: ok (${tracked.length} tracked files, ${extraCount} extra files)\n`);
