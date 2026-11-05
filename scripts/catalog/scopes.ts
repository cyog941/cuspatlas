import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type CatalogOperation,
  type CatalogPrincipal,
  RELATIONSHIP_SCOPES,
  scopeNameDefect,
} from '../../packages/contracts/src/catalog/catalog';
import { ROOT } from './build-catalog';

/**
 * The human registry is the "Scope registry table" in the "Roles and scopes" section of
 * docs/SHARED-CONTRACTS.md (A-S8): only its rows register a scope, and its `Human only` column is the
 * authoritative human-only flag (A-M2). Prose mentions never register anything. The machine-readable
 * registry (packages/contracts/src/catalog/scopes.json) is generated from the catalog plus that flag.
 */
function registryRows(root: string): Map<string, boolean> {
  const doc = readFileSync(resolve(root, 'docs/SHARED-CONTRACTS.md'), 'utf8');
  const start = doc.indexOf('### Scope registry table');
  const end = doc.indexOf('### Relationship scopes', start);
  if (start < 0 || end < 0) throw new Error('scope registry table not found in SHARED-CONTRACTS.md');
  const out = new Map<string, boolean>();
  for (const m of doc.slice(start, end).matchAll(/^\| `([^`\s]+)` \| (yes|no) \|$/gm)) {
    const name = m[1] as string;
    if (scopeNameDefect(name) !== null) throw new Error(`registry row ${name}: ${scopeNameDefect(name)}`);
    if (out.has(name)) throw new Error(`registry row ${name} is duplicated`);
    out.set(name, m[2] === 'yes');
  }
  return out;
}

export function registeredScopes(root = ROOT): Set<string> {
  return new Set(registryRows(root).keys());
}

/** Scopes SHARED-CONTRACTS marks human only: never granted to a service, portal or device principal. */
export function humanOnlyScopes(root = ROOT): Set<string> {
  return new Set([...registryRows(root)].filter(([, h]) => h).map(([n]) => n));
}

export interface ScopeDefinition {
  readonly name: string;
  readonly noun: string;
  readonly verb: string;
  /** Principal kinds the policy table admits for at least one operation using the scope. */
  readonly principalClasses: readonly CatalogPrincipal[];
  /** SHARED-CONTRACTS registry flag (A-M2): never grant it to a service, portal or device principal. */
  readonly humanOnly: boolean;
  readonly owners: readonly string[];
  readonly operations: readonly string[];
  /** Highest PHI class among its operations. */
  readonly sensitivity: CatalogOperation['sensitivity'];
}

const RANK = { none: 0, operational: 1, phi: 2, phiBulk: 3 } as const;

export interface ScopeRegistry {
  readonly version: 1;
  readonly scopes: readonly ScopeDefinition[];
  /** S5 relationship scopes: evaluated by the relationship policy, never staff scopes. */
  readonly relationshipScopes: readonly string[];
}

export function buildScopeRegistry(
  catalog: readonly CatalogOperation[],
  humanOnly: ReadonlySet<string> = humanOnlyScopes(),
): ScopeRegistry {
  const by = new Map<string, CatalogOperation[]>();
  for (const o of catalog) {
    if (o.scope === null) continue;
    by.set(o.scope, [...(by.get(o.scope) ?? []), o]);
  }
  const scopes = [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, ops]): ScopeDefinition => {
      const [noun, verb] = name.split('.') as [string, string];
      const kinds = new Set(ops.flatMap((o) => o.principals));
      const principalClasses = (['human', 'service', 'portal', 'device'] as const).filter((k) =>
        kinds.has(k),
      );
      return {
        name,
        noun,
        verb,
        principalClasses,
        humanOnly: humanOnly.has(name),
        owners: [...new Set(ops.map((o) => o.owner))].sort(),
        operations: ops.map((o) => o.operation),
        sensitivity: ops.reduce<CatalogOperation['sensitivity']>(
          (acc, o) => (RANK[o.sensitivity] > RANK[acc] ? o.sensitivity : acc),
          'none',
        ),
      };
    });
  return { version: 1, scopes, relationshipScopes: [...RELATIONSHIP_SCOPES] };
}
