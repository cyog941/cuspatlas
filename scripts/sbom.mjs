// Generates artifacts/sbom.cdx.json (CycloneDX 1.5) from pnpm-lock.yaml plus `pnpm licenses list --json`,
// and a SKELETON artifacts/evidence-manifest.json. No dependencies, no network.
// The evidence manifest `controls` array is intentionally empty here: AS-01..AS-04 evidence is
// populated by the restore/evidence task, not by this script.
import { execFileSync, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const now = new Date().toISOString();

// License map name@version -> SPDX-ish string, from pnpm's view of the installed tree.
const licenses = new Map();
let licOut = null;
try {
  licOut = execSync('corepack pnpm licenses list --json', {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
} catch {
  licOut = null;
}
if (licOut) {
  const byLicense = JSON.parse(licOut);
  for (const [license, pkgs] of Object.entries(byLicense)) {
    for (const p of pkgs) for (const v of p.versions) licenses.set(`${p.name}@${v}`, license);
  }
} else {
  process.stderr.write('sbom: pnpm licenses list failed; licenses will be NOASSERTION\n');
}

// Lockfile `packages:` section (lockfileVersion 9): keys like `'@scope/name@1.2.3':` or `name@1.2.3:`.
const lines = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8').split(/\r?\n/);
const start = lines.indexOf('packages:');
const end = lines.indexOf('snapshots:');
if (start < 0 || end < start) throw new Error('pnpm-lock.yaml: packages section not found');
const components = [];
let current = null;
for (const line of lines.slice(start + 1, end)) {
  const key = /^ {2}'?((?:@[^/@\s]+\/)?[^@\s']+)@([^'\s:]+)'?:\s*$/.exec(line);
  if (key) {
    current = { name: key[1], version: key[2], integrity: undefined };
    components.push(current);
    continue;
  }
  const integ = /^ {4}resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)/.exec(line);
  if (integ && current) current.integrity = integ[1];
}
if (components.length === 0) throw new Error('no components parsed from pnpm-lock.yaml');

const purl = (name, version) =>
  `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${encodeURIComponent(version)}`;

const cdxComponents = components.map((c) => {
  const license = licenses.get(`${c.name}@${c.version}`);
  const entry = {
    type: 'library',
    'bom-ref': purl(c.name, c.version),
    name: c.name,
    version: c.version,
    purl: purl(c.name, c.version),
    licenses: license ? [{ expression: license }] : [{ license: { name: 'NOASSERTION' } }],
  };
  if (c.integrity) {
    entry.hashes = [{ alg: 'SHA-512', content: Buffer.from(c.integrity.slice(7), 'base64').toString('hex') }];
  }
  return entry;
});

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: now,
    tools: { components: [{ type: 'application', name: 'cuspatlas-sbom', version: '1' }] },
    component: {
      type: 'application',
      'bom-ref': `cuspatlas@${rootPkg.version}`,
      name: 'cuspatlas',
      version: rootPkg.version,
      licenses: [{ license: { id: rootPkg.license } }],
      properties: [{ name: 'cuspatlas:git-commit', value: commit }],
    },
  },
  components: cdxComponents,
};

const outDir = join(root, 'artifacts');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'sbom.cdx.json'), `${JSON.stringify(bom, null, 2)}\n`);
writeFileSync(
  join(outDir, 'evidence-manifest.json'),
  `${JSON.stringify({ schemaVersion: 1, commit, generatedAt: now, controls: [] }, null, 2)}\n`,
);
const unlicensed = cdxComponents.filter((c) => c.licenses[0].license?.name === 'NOASSERTION').length;
process.stdout.write(
  `sbom: ${cdxComponents.length} components (${unlicensed} without a license from the installed tree) at ${commit}\n`,
);
