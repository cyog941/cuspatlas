import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { validateCatalog } from '../../packages/contracts/src/catalog/catalog';
import { buildCatalog, ROOT, stableJson } from './build-catalog';
import { registeredScopes } from './scopes';

/**
 * Every generated artifact (path relative to the repository root -> exact content). Everything is
 * built in memory and validated first; a failure throws before anything is written.
 */
export function generatedArtifacts(): Record<string, string> {
  const catalog = buildCatalog();
  const defects = validateCatalog(catalog, registeredScopes());
  if (defects.length > 0) throw new Error(`catalog invalid; nothing written:\n${defects.join('\n')}`);
  return {
    'packages/contracts/src/catalog/operations.json': stableJson(catalog),
  };
}

const read = (p: string) => {
  try {
    return readFileSync(resolve(ROOT, p), 'utf8');
  } catch {
    return null;
  }
};

/** Paths whose committed content differs from a fresh generation. */
export function catalogDrift(): string[] {
  return Object.entries(generatedArtifacts())
    .filter(([p, content]) => read(p) !== content)
    .map(([p]) => p);
}

export function runCli(mode: string | undefined): void {
  if (mode === 'generate') {
    const artifacts = generatedArtifacts();
    for (const [p, content] of Object.entries(artifacts)) {
      if (read(p) === content) continue;
      mkdirSync(dirname(resolve(ROOT, p)), { recursive: true });
      writeFileSync(resolve(ROOT, p), content);
      process.stdout.write(`wrote ${p}\n`);
    }
  } else if (mode === 'check') {
    const drift = catalogDrift();
    if (drift.length > 0) {
      process.stderr.write(
        `generated artifacts are stale (run pnpm catalog:generate):\n${drift.join('\n')}\n`,
      );
      process.exit(1);
    }
    process.stdout.write('catalog artifacts up to date\n');
  } else {
    process.stderr.write('usage: main.ts generate|check\n');
    process.exit(2);
  }
}
