import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { validateCatalog } from '../../packages/contracts/src/catalog/catalog';
import { DEPRECATIONS } from '../../packages/contracts/src/catalog/deprecation';
import { LIST_OPERATIONS } from '../../packages/contracts/src/list-operations';
import {
  BASELINE_PATH,
  type BaseState,
  buildBaseline,
  changeControlRefusals,
  loadBaseState,
  readBaseline,
  resolveBaseRef,
} from './baseline';
import { buildCatalog, ROOT, stableJson } from './build-catalog';
import { openApiQueryParams, renderClient } from './client';
import { renderCatalogMd, renderScopesMd, renderSunsetMd } from './docs';
import { buildScopeRegistry, registeredScopes } from './scopes';

/**
 * Every generated artifact (path relative to the repository root -> exact content). Everything is
 * built in memory and validated first; a failure throws before anything is written.
 */
export function generatedArtifacts(
  opts: { readonly firstPublication?: boolean; readonly base?: BaseState } = {},
): Record<string, string> {
  const catalog = buildCatalog();
  const defects = validateCatalog(catalog, registeredScopes());
  if (defects.length > 0) throw new Error(`catalog invalid; nothing written:\n${defects.join('\n')}`);
  const registry = buildScopeRegistry(catalog);
  const baseline = buildBaseline(catalog);
  // A5/A-M1: the published baseline only moves forward through a change the gate accepts, judged
  // against the baseline and deprecations at the merge base (never the working tree's own copies).
  const refused = changeControlRefusals({
    current: baseline,
    workingTreeBaseline: () => readBaseline(),
    base: opts.base ?? loadBaseState(resolveBaseRef()),
    today: new Date().toISOString().slice(0, 10),
    firstPublication: opts.firstPublication,
  });
  if (refused.length > 0) {
    throw new Error(`breaking contract change refused; nothing written:\n${refused.join('\n')}`);
  }
  return {
    'packages/contracts/src/catalog/operations.json': stableJson(catalog),
    'packages/contracts/src/catalog/scopes.json': stableJson(registry),
    [BASELINE_PATH]: stableJson(baseline),
    'packages/client/src/generated.ts': renderClient(catalog),
    'packages/contracts/src/catalog/list-query-keys.json': listQueryKeys(),
    'docs/api/operation-catalog.md': renderCatalogMd(catalog),
    'docs/api/scopes.md': renderScopesMd(registry),
    'docs/api/sunset-register.md': renderSunsetMd(DEPRECATIONS),
  };
}

/**
 * A batch 3 hardening: the documented query parameter names of every registered list operation
 * (docs/api/openapi.yaml), the allowlist a saved view's filter keys are checked against.
 */
function listQueryKeys(): string {
  const params = openApiQueryParams();
  const out: Record<string, string[]> = {};
  for (const op of Object.keys(LIST_OPERATIONS).sort())
    out[op] = [...new Set((params.get(op) ?? []).map((q) => q.name))].sort();
  return stableJson(out);
}

const read = (p: string) => {
  try {
    return readFileSync(resolve(ROOT, p), 'utf8');
  } catch {
    return null;
  }
};

/** Paths whose committed content differs from a fresh generation. */
export function catalogDrift(opts: { readonly firstPublication?: boolean } = {}): string[] {
  return Object.entries(generatedArtifacts(opts))
    .filter(([p, content]) => read(p) !== content)
    .map(([p]) => p);
}

export function runCli(mode: string | undefined, flags: readonly string[] = []): void {
  const firstPublication = flags.includes('--first-publication');
  if (mode === 'generate') {
    const artifacts = generatedArtifacts({ firstPublication });
    for (const [p, content] of Object.entries(artifacts)) {
      if (read(p) === content) continue;
      mkdirSync(dirname(resolve(ROOT, p)), { recursive: true });
      writeFileSync(resolve(ROOT, p), content);
      process.stdout.write(`wrote ${p}\n`);
    }
  } else if (mode === 'check') {
    const drift = catalogDrift({ firstPublication });
    if (drift.length > 0) {
      process.stderr.write(
        `generated artifacts are stale (run pnpm catalog:generate):\n${drift.join('\n')}\n`,
      );
      process.exit(1);
    }
    process.stdout.write('catalog artifacts up to date\n');
  } else {
    process.stderr.write('usage: main.ts generate|check [--first-publication]\n');
    process.exit(2);
  }
}
