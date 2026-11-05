import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CatalogOperation, DeprecationEntry } from '../../packages/contracts/src/catalog/catalog';
import {
  type Baseline,
  type Change,
  classifyChange,
  summarizeInput,
} from '../../packages/contracts/src/catalog/change-control';
import { ROOT } from './build-catalog';
import { defsOf, type Json, loadSchemaFiles, parseSchemaRef } from './schemas';

export const BASELINE_PATH = 'packages/contracts/src/catalog/baseline.json';
export const BASELINE_VERSION = 1;

/** The published contract of the current catalog (what change control compares against). */
export function buildBaseline(catalog: readonly CatalogOperation[], version = BASELINE_VERSION): Baseline {
  const files = loadSchemaFiles();
  return {
    version,
    operations: catalog.map((o) => {
      const ref = o.rest?.requestSchema ? parseSchemaRef(o.rest.requestSchema) : null;
      const doc = ref ? (files[ref.file] as Json) : null;
      return {
        operation: o.operation,
        transports: o.transports,
        scope: o.scope,
        principals: o.principals,
        ...(o.rest ? { rest: { method: o.rest.method, path: o.rest.path } } : {}),
        ...(o.mcpTool ? { mcpTool: o.mcpTool } : {}),
        ...(ref && doc ? { input: summarizeInput(defsOf(doc)[ref.def], doc) } : {}),
      };
    }),
  };
}

export function readBaseline(root = ROOT): Baseline {
  return JSON.parse(readFileSync(resolve(root, BASELINE_PATH), 'utf8')) as Baseline;
}

/**
 * Breaking changes the gate refuses: every breaking change of an operation that has no deprecation
 * entry, or whose sunset date has not passed yet (removing early is still breaking).
 */
export function gateViolations(
  changes: readonly Change[],
  deprecations: readonly DeprecationEntry[],
  today: string,
): string[] {
  const dep = new Map(deprecations.map((d) => [d.operation, d]));
  return changes
    .filter((c) => c.class === 'breaking')
    .filter((c) => {
      const d = dep.get(c.operation);
      return !d || d.sunset > today;
    })
    .map((c) => {
      const d = dep.get(c.operation);
      const why = d
        ? `deprecated but its sunset ${d.sunset} has not passed`
        : 'no deprecation entry with a sunset date';
      return `${c.operation} ${c.path}: ${c.reason} (${why})`;
    });
}

export function compareWithBaseline(prev: Baseline, next: Baseline): Change[] {
  return classifyChange(prev, next);
}
