import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './build-catalog';

/** Route-manifest schema prefixes -> JSON Schema files in packages/contracts/src (see RouteContract). */
export const SCHEMA_FILES: Record<string, string> = {
  '': 'synthetic-task.schema.json',
  proposal: 'action-proposal.schema.json',
  patient: 'patient.schema.json',
  scheduling: 'scheduling.schema.json',
  billing: 'billing.schema.json',
  clinical: 'clinical.schema.json',
  engagement: 'engagement.schema.json',
  imaging: 'imaging.schema.json',
  migration: 'migration.schema.json',
};

export type Json = { readonly [k: string]: unknown };

export interface SchemaRef {
  readonly prefix: string;
  readonly file: string;
  readonly def: string;
}

/** Parses a manifest schema reference (`billing:Name`, `Name`, or `#/components/schemas/Name`). */
export function parseSchemaRef(ref: string): SchemaRef | null {
  if (ref.startsWith('#/components/schemas/')) return null;
  const i = ref.indexOf(':');
  const prefix = i < 0 ? '' : ref.slice(0, i);
  const file = SCHEMA_FILES[prefix];
  if (!file) throw new Error(`unknown schema prefix in ${ref}`);
  return { prefix, file, def: i < 0 ? ref : ref.slice(i + 1) };
}

export function loadSchemaFiles(root = ROOT): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const f of Object.values(SCHEMA_FILES)) {
    out[f] = JSON.parse(readFileSync(resolve(root, 'packages/contracts/src', f), 'utf8')) as Json;
  }
  return out;
}

const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

export function defsOf(doc: Json): Json {
  return isObj(doc.$defs) ? doc.$defs : {};
}

/** Every `$defs` name reachable from the given roots inside one schema document. */
export function reachableDefs(doc: Json, roots: Iterable<string>): Set<string> {
  const defs = defsOf(doc);
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (!isObj(node)) return;
    const ref = node.$ref;
    if (typeof ref === 'string' && ref.startsWith('#/$defs/')) enter(ref.slice('#/$defs/'.length));
    for (const v of Object.values(node)) visit(v);
  };
  const enter = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    visit(defs[name]);
  };
  for (const r of roots) enter(r);
  return seen;
}
