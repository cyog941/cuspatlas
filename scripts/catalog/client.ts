import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CatalogOperation } from '../../packages/contracts/src/catalog/catalog';
import { ROOT } from './build-catalog';
import { defsOf, type Json, loadSchemaFiles, parseSchemaRef, reachableDefs, SCHEMA_FILES } from './schemas';

/**
 * A1 generated TypeScript client: types derived from the same JSON Schemas the server validates with,
 * and one typed entry per REST operation of the catalog. No business logic: the hand-written part of
 * the package (src/index.ts) is only the HTTP transport.
 */
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const pascal = (s: string) => s.replace(/(^|[-_.:\s])(\w)/g, (_m, _p, c: string) => c.toUpperCase());
const typeName = (prefix: string, def: string) => `${pascal(prefix || 'synthetic')}${pascal(def)}`;
const prefixOfFile = (file: string) => Object.entries(SCHEMA_FILES).find(([, f]) => f === file)?.[0] ?? '';

function literal(v: unknown): string {
  return JSON.stringify(v);
}

/** The schema document being converted (deep  pointers are inlined from it). */
let currentDoc: Json = {};

function pointer(ref: string): unknown {
  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>(
      (n, k) => (isObj(n) ? n[k.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined),
      currentDoc,
    );
}

function toTs(node: unknown, prefix: string, depth = 0): string {
  if (node === true || node === undefined) return 'unknown';
  if (node === false) return 'never';
  if (!isObj(node)) return 'unknown';
  if (typeof node.$ref === 'string') {
    const name = node.$ref.startsWith('#/$defs/') ? node.$ref.slice(8) : null;
    if (name && !name.includes('/')) return typeName(prefix, name);
    return name && depth < 12 ? toTs(pointer(node.$ref), prefix, depth + 1) : 'unknown';
  }
  if ('const' in node) return literal(node.const);
  if (Array.isArray(node.enum)) return node.enum.map(literal).join(' | ') || 'never';
  const alts = (key: 'oneOf' | 'anyOf') =>
    Array.isArray(node[key]) ? (node[key] as unknown[]).map((n) => `(${toTs(n, prefix, depth)})`) : null;
  const one = alts('oneOf') ?? alts('anyOf');
  if (one) return one.join(' | ');
  if (Array.isArray(node.allOf))
    return (node.allOf as unknown[]).map((n) => `(${toTs(n, prefix, depth)})`).join(' & ');
  const t = node.type;
  if (Array.isArray(t)) return t.map((x) => toTs({ ...node, type: x }, prefix, depth)).join(' | ');
  switch (t) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return `readonly (${toTs(node.items, prefix, depth)})[]`;
    case 'object':
    case undefined: {
      if (!isObj(node.properties)) {
        if (t === undefined) return 'unknown';
        return isObj(node.additionalProperties)
          ? `{ readonly [k: string]: ${toTs(node.additionalProperties, prefix, depth)} }`
          : '{ readonly [k: string]: unknown }';
      }
      const req = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
      const pad = '  '.repeat(depth + 1);
      const fields = Object.entries(node.properties).map(
        ([k, v]) =>
          `${pad}readonly ${JSON.stringify(k)}${req.has(k) ? '' : '?'}: ${toTs(v, prefix, depth + 1)};`,
      );
      if (node.additionalProperties !== false) fields.push(`${pad}readonly [k: string]: unknown;`);
      return `{\n${fields.join('\n')}\n${'  '.repeat(depth)}}`;
    }
    default:
      return 'unknown';
  }
}

function refType(ref: string | undefined, media: string | undefined): string {
  if (media === 'application/octet-stream') return 'Uint8Array';
  if (ref === undefined) return 'undefined';
  const r = parseSchemaRef(ref);
  return r ? typeName(r.prefix, r.def) : 'unknown';
}

interface QueryParam {
  readonly name: string;
  readonly required: boolean;
}

/**
 * A-S6: the documented query parameters of each operation (docs/api/openapi.yaml), so the client's
 * query type is closed exactly where the contract is: unknown keys are a type error.
 */
export function openApiQueryParams(root = ROOT): Map<string, QueryParam[]> {
  const lines = readFileSync(resolve(root, 'docs/api/openapi.yaml'), 'utf8').split(/\r?\n/);
  const components = new Map<string, QueryParam & { in: string }>();
  const start = lines.indexOf('  parameters:', lines.indexOf('components:'));
  if (start >= 0) {
    let current: string | null = null;
    let entry: { name?: string; in?: string; required?: boolean } = {};
    const flush = () => {
      if (current && entry.name && entry.in)
        components.set(current, { name: entry.name, in: entry.in, required: entry.required === true });
    };
    for (const line of lines.slice(start + 1)) {
      if (/^ {0,3}\S/.test(line)) break;
      const head = /^ {4}([A-Za-z0-9_]+):$/.exec(line);
      if (head) {
        flush();
        current = head[1] as string;
        entry = {};
        continue;
      }
      const kv = /^ {6}(name|in|required): (.+)$/.exec(line);
      if (kv) {
        if (kv[1] === 'required') entry.required = kv[2] === 'true';
        else entry[kv[1] as 'name' | 'in'] = kv[2] as string;
      }
    }
    flush();
  }
  const out = new Map<string, QueryParam[]>();
  let op: string | null = null;
  let pending: { name?: string; in?: string; required?: boolean } | null = null;
  const push = () => {
    if (op && pending?.name && pending.in === 'query')
      out.set(op, [...(out.get(op) ?? []), { name: pending.name, required: pending.required === true }]);
    pending = null;
  };
  for (const line of lines) {
    if (/^ {4}(get|post|put|patch|delete):$/.test(line) || /^ {2}\S/.test(line)) {
      push();
      op = null;
      continue;
    }
    const id = /^ {6}operationId: (\S+)$/.exec(line);
    if (id) op = id[1] as string;
    const ref = /^ {8}- \$ref: '#\/components\/parameters\/([A-Za-z0-9_]+)'$/.exec(line);
    if (ref) {
      push();
      const c = components.get(ref[1] as string);
      if (c) pending = { ...c };
      push();
      continue;
    }
    const name = /^ {8}- name: (\S+)$/.exec(line);
    if (name) {
      push();
      pending = { name: name[1] as string };
      continue;
    }
    const kv = /^ {10}(in|required): (\S+)$/.exec(line);
    if (kv && pending) {
      if (kv[1] === 'required') pending.required = kv[2] === 'true';
      else pending.in = kv[2] as string;
    }
  }
  push();
  return out;
}

const queryType = (params: readonly QueryParam[]): string =>
  params.length === 0
    ? 'Record<string, never>'
    : `{ ${params.map((p) => `readonly ${p.name}${p.required ? '' : '?'}: string;`).join(' ')} }`;

export function renderClient(catalog: readonly CatalogOperation[]): string {
  const files = loadSchemaFiles();
  const rest = catalog.filter((o) => o.rest !== undefined);
  const roots = new Map<string, Set<string>>();
  const want = (ref: string | undefined) => {
    const r = ref ? parseSchemaRef(ref) : null;
    if (!r) return;
    roots.set(r.file, (roots.get(r.file) ?? new Set()).add(r.def));
  };
  want('Refusal');
  for (const o of rest) {
    want(o.rest?.requestSchema);
    want(o.rest?.successSchema);
  }
  const types: string[] = [];
  for (const [file, defs] of [...roots.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const doc = files[file] as Json;
    const prefix = prefixOfFile(file);
    currentDoc = doc;
    for (const def of [...reachableDefs(doc, defs)].filter((d) => !d.includes('/')).sort()) {
      types.push(`export type ${typeName(prefix, def)} = ${toTs(defsOf(doc)[def], prefix)};`);
    }
  }
  const queries = openApiQueryParams();
  const entries = rest.map((o) => {
    const r = o.rest as NonNullable<CatalogOperation['rest']>;
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
    const m = { request: o.rest?.requestMedia, success: o.rest?.successMedia };
    const body =
      r.method === 'post' ? refType(r.requestSchema ?? '#/components/schemas/Empty', m.request) : 'undefined';
    return `  ${JSON.stringify(o.operation)}: {
    method: ${JSON.stringify(r.method.toUpperCase())};
    path: ${JSON.stringify(r.path)};
    params: { ${params.map((p) => `readonly ${p}: string;`).join(' ')} };
    query: ${queryType(queries.get(o.operation) ?? [])};
    body: ${r.requestSchema || m.request ? body : r.method === 'post' ? 'Record<string, never> | undefined' : 'undefined'};
    result: ${refType(r.successSchema, m.success)};
    successStatus: ${r.successStatus};
    idempotent: ${o.idempotency === 'required'};
  };`;
  });
  const table = rest.map((o) => {
    const r = o.rest as NonNullable<CatalogOperation['rest']>;
    const m = { request: o.rest?.requestMedia, success: o.rest?.successMedia };
    return `  ${JSON.stringify(o.operation)}: { method: ${JSON.stringify(r.method.toUpperCase())}, path: ${JSON.stringify(r.path)}, successStatus: ${r.successStatus}, idempotencyKey: ${o.idempotency === 'required'}, binaryRequest: ${m.request === 'application/octet-stream'}, binaryResult: ${m.success === 'application/octet-stream'}, deprecated: ${o.status === 'deprecated'} },`;
  });
  return `// Generated by \`pnpm catalog:generate\` from the operation catalog and the JSON Schemas in
// packages/contracts/src. Do not edit: the build overwrites this file and CI fails when it is stale.
/* eslint-disable */

${types.join('\n\n')}

/** Every REST operation of the catalog with its path parameters, body and success result types. */
export interface Operations {
${entries.join('\n')}
}

export type OperationId = keyof Operations;

export interface OperationMeta {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly successStatus: number;
  readonly idempotencyKey: boolean;
  readonly binaryRequest: boolean;
  readonly binaryResult: boolean;
  readonly deprecated: boolean;
}

export const OPERATIONS: { readonly [K in OperationId]: OperationMeta } = {
${table.join('\n')}
};
`;
}
