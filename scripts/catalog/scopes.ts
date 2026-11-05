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
 * The human registry is the "Roles and scopes" section of docs/SHARED-CONTRACTS.md: a scope is
 * registered when it appears there in backticks as `noun.verb`. The machine-readable registry
 * (packages/contracts/src/catalog/scopes.json) is generated from the catalog and must agree with it.
 */
export function registeredScopes(root = ROOT): Set<string> {
  const doc = readFileSync(resolve(root, 'docs/SHARED-CONTRACTS.md'), 'utf8');
  const start = doc.indexOf('## Roles and scopes');
  const end = doc.indexOf('### Relationship scopes', start);
  if (start < 0 || end < 0) throw new Error('scope registry section not found in SHARED-CONTRACTS.md');
  const out = new Set<string>();
  for (const m of doc.slice(start, end).matchAll(/`([^`\s]+)`/g)) {
    const name = m[1] as string;
    if (scopeNameDefect(name) === null) out.add(name);
  }
  return out;
}

export interface ScopeDefinition {
  readonly name: string;
  readonly noun: string;
  readonly verb: string;
  /** Principal kinds the policy table admits for at least one operation using the scope. */
  readonly principalClasses: readonly CatalogPrincipal[];
  /** True when every operation using the scope is human-only: never grant it to a service/agent. */
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

export function buildScopeRegistry(catalog: readonly CatalogOperation[]): ScopeRegistry {
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
        humanOnly: principalClasses.length === 1 && principalClasses[0] === 'human',
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
