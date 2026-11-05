/**
 * A5 change control. A baseline is the published contract: per operation its transports, scope,
 * REST shape and a normalized summary of its request schema. `classifyChange` compares two baselines.
 */

type Json = { readonly [k: string]: unknown };
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Normalized, $ref-resolved request schema summary (what a client must send). */
export interface InputShape {
  readonly type?: readonly string[];
  readonly required?: readonly string[];
  readonly properties?: { readonly [k: string]: InputShape };
  readonly closed?: boolean;
  readonly items?: InputShape;
  readonly enum?: readonly string[];
  readonly maxLength?: number;
  readonly minLength?: number;
  readonly maximum?: number;
  readonly minimum?: number;
  readonly maxItems?: number;
  readonly minItems?: number;
  readonly uniqueItems?: boolean;
  readonly multipleOf?: number;
  readonly exclusiveMaximum?: number;
  readonly exclusiveMinimum?: number;
  readonly format?: string;
  readonly pattern?: string;
  /** Values of a keyed map (`additionalProperties` as a schema). */
  readonly additional?: InputShape;
  /** Canonical JSON of `not`, `if`/`then`/`else` (any change is treated as breaking). */
  readonly not?: string;
  readonly conditional?: string;
  /** Alternatives (oneOf/anyOf), each summarized. */
  readonly anyOf?: readonly InputShape[];
}

export interface BaselineOperation {
  readonly operation: string;
  readonly transports: readonly string[];
  readonly scope: string | null;
  readonly principals: readonly string[];
  readonly rest?: { readonly method: string; readonly path: string };
  readonly mcpTool?: string;
  readonly input?: InputShape;
  /** A-S7: `none` | `optional` | `required`. */
  readonly idempotency?: string;
  /** A-S7: documented refusal statuses. */
  readonly refusals?: readonly string[];
}

export interface Baseline {
  readonly version: number;
  readonly operations: readonly BaselineOperation[];
}

const MAX_DEPTH = 8;

const NUMERIC_KEYS = [
  'maxLength',
  'minLength',
  'maximum',
  'minimum',
  'maxItems',
  'minItems',
  'multipleOf',
  'exclusiveMaximum',
  'exclusiveMinimum',
] as const;

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : isObj(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sortKeys(v[k])]),
        )
      : v;
const canonical = (v: unknown) => JSON.stringify(sortKeys(v));

/** Merges two summaries that must both hold (allOf). */
export function mergeAll(a: InputShape, b: InputShape): InputShape {
  const out: { -readonly [K in keyof InputShape]: InputShape[K] } = { ...a };
  if (a.type && b.type) out.type = a.type.filter((t) => b.type?.includes(t));
  else if (b.type) out.type = b.type;
  if (a.enum && b.enum) out.enum = a.enum.filter((v) => b.enum?.includes(v));
  else if (b.enum) out.enum = b.enum;
  const min = (x?: number, y?: number) => (x === undefined ? y : y === undefined ? x : Math.min(x, y));
  const max = (x?: number, y?: number) => (x === undefined ? y : y === undefined ? x : Math.max(x, y));
  for (const k of ['maxLength', 'maximum', 'maxItems', 'exclusiveMaximum'] as const) {
    const v = min(a[k], b[k]);
    if (v !== undefined) out[k] = v;
  }
  for (const k of ['minLength', 'minimum', 'minItems', 'exclusiveMinimum'] as const) {
    const v = max(a[k], b[k]);
    if (v !== undefined) out[k] = v;
  }
  for (const k of ['multipleOf', 'format', 'pattern', 'not', 'conditional'] as const) {
    if (b[k] !== undefined) (out as Record<string, unknown>)[k] = b[k];
  }
  if (a.uniqueItems || b.uniqueItems) out.uniqueItems = true;
  if (a.properties || b.properties) {
    const props: Record<string, InputShape> = { ...(a.properties ?? {}) };
    for (const [k, v] of Object.entries(b.properties ?? {})) props[k] = props[k] ? mergeAll(props[k], v) : v;
    out.properties = Object.fromEntries(Object.entries(props).sort(([x], [y]) => (x < y ? -1 : 1)));
  }
  if (a.closed || b.closed) out.closed = true;
  else if (a.closed === false || b.closed === false) out.closed = false;
  const req = new Set([...(a.required ?? []), ...(b.required ?? [])]);
  if (req.size > 0) out.required = [...req].sort();
  if (a.items && b.items) out.items = mergeAll(a.items, b.items);
  else if (b.items) out.items = b.items;
  if (a.additional && b.additional) out.additional = mergeAll(a.additional, b.additional);
  else if (b.additional) out.additional = b.additional;
  if (b.anyOf) out.anyOf = b.anyOf;
  return out;
}

/** Summarizes a JSON Schema node, resolving local `#/$defs/` references in `doc`. */
export function summarizeInput(
  node: unknown,
  doc: Json,
  depth = 0,
  seen: readonly string[] = [],
): InputShape {
  if (!isObj(node) || depth > MAX_DEPTH) return {};
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/$defs/')) {
    const name = node.$ref.slice(8);
    if (seen.includes(name)) return {};
    const defs = isObj(doc.$defs) ? doc.$defs : {};
    return summarizeInput(defs[name], doc, depth + 1, [...seen, name]);
  }
  const out: { -readonly [K in keyof InputShape]: InputShape[K] } = {};
  if (typeof node.type === 'string') out.type = [node.type];
  else if (Array.isArray(node.type)) out.type = [...(node.type as string[])].sort();
  if ('const' in node) out.enum = [JSON.stringify(node.const)];
  if (Array.isArray(node.enum)) out.enum = node.enum.map((v) => JSON.stringify(v)).sort();
  for (const k of NUMERIC_KEYS) {
    if (typeof node[k] === 'number') out[k] = node[k] as number;
  }
  if (node.uniqueItems === true) out.uniqueItems = true;
  if (typeof node.format === 'string') out.format = node.format;
  if (typeof node.pattern === 'string') out.pattern = node.pattern;
  if (node.not !== undefined) out.not = canonical(summarizeInput(node.not, doc, depth + 1, seen));
  if (node.if !== undefined || node.then !== undefined || node.else !== undefined) {
    out.conditional = canonical(
      ['if', 'then', 'else'].map((k) =>
        node[k] === undefined ? null : summarizeInput(node[k], doc, depth + 1, seen),
      ),
    );
  }
  if (isObj(node.additionalProperties)) {
    out.additional = summarizeInput(node.additionalProperties, doc, depth + 1, seen);
  }
  if (node.additionalProperties === false) out.closed = true;
  if (isObj(node.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(node.properties)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, summarizeInput(v, doc, depth + 1, seen)]),
    );
    out.closed = node.additionalProperties === false;
  }
  if (isObj(node.patternProperties)) out.closed = false;
  if (Array.isArray(node.required)) out.required = [...(node.required as string[])].sort();
  if (node.items !== undefined) out.items = summarizeInput(node.items, doc, depth + 1, seen);
  const alts = (Array.isArray(node.oneOf) ? node.oneOf : Array.isArray(node.anyOf) ? node.anyOf : null) as
    | unknown[]
    | null;
  if (alts) out.anyOf = alts.map((a) => summarizeInput(a, doc, depth + 1, seen));
  if (Array.isArray(node.allOf)) {
    // A conjunction: every part must hold, so the merged summary keeps the tightest constraint.
    let merged: InputShape = out;
    for (const part of node.allOf as unknown[])
      merged = mergeAll(merged, summarizeInput(part, doc, depth + 1, seen));
    return merged;
  }
  return out;
}

export type ChangeClass = 'additive' | 'breaking';

export interface Change {
  readonly operation: string;
  readonly class: ChangeClass;
  readonly path: string;
  readonly reason: string;
}

/** Split a regex body on top-level `|` (outside groups and classes); null when unbalanced. */
function topLevelAlternatives(body: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let cls = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (cls) {
      if (c === ']') cls = false;
      continue;
    }
    if (c === '[') cls = true;
    else if (c === '(') depth++;
    else if (c === ')' && --depth < 0) return null;
    else if (c === '|' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0 || cls) return null;
  parts.push(body.slice(start));
  return parts;
}

/** True when the group opened at body[0] closes at the last character (`(a)(b)` is two groups). */
function groupSpansBody(body: string): boolean {
  let depth = 0;
  let cls = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (cls) {
      if (c === ']') cls = false;
      continue;
    }
    if (c === '[') cls = true;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i === body.length - 1;
  }
  return false;
}

/** The alternatives of a fully anchored pattern: `^P$` gives [P]; `^(A|B)$` or `^(?:A|B)$` gives [A, B]. */
function anchoredAlternatives(pattern: string): string[] | null {
  if (!pattern.startsWith('^') || !pattern.endsWith('$') || pattern.endsWith('\\$')) return null;
  const body = pattern.slice(1, -1);
  const top = topLevelAlternatives(body);
  if (!top || top.length !== 1) return null; // `^A|B$` anchors each side separately
  const open = body.startsWith('(?:') ? 3 : body.startsWith('(') && !body.startsWith('(?') ? 1 : 0;
  if (open > 0 && groupSpansBody(body)) return topLevelAlternatives(body.slice(open, -1));
  return [body];
}

/**
 * A pattern change that only adds alternatives (every string valid before stays valid): each
 * alternative of the anchored `prev` is an alternative of the anchored `next`, e.g. `^P$` to
 * `^(P|Q)$`. Anything else is treated as a change.
 */
export function patternWidens(prev: string | undefined, next: string): boolean {
  if (prev === undefined) return false;
  const a = anchoredAlternatives(prev);
  const b = anchoredAlternatives(next);
  if (!a || !b) return false;
  return a.every((alt) => b.includes(alt));
}

/** Every input-side tightening of `next` against `prev` (a client valid before may now fail). */
export function inputBreaks(prev: InputShape, next: InputShape, path = '$'): Change[] {
  const out: Change[] = [];
  const add = (p: string, reason: string) => out.push({ operation: '', class: 'breaking', path: p, reason });
  if (prev.type && next.type) {
    const lost = prev.type.filter(
      (t) => !next.type?.includes(t) && !(t === 'integer' && next.type?.includes('number')),
    );
    if (lost.length > 0)
      add(path, lost.includes('null') ? 'nullable made non-null' : `type narrowed (${lost.join(',')})`);
  } else if (!prev.type && next.type) add(path, 'type constraint added');
  if (prev.enum || next.enum) {
    if (next.enum && (!prev.enum || prev.enum.some((v) => !next.enum?.includes(v))))
      add(path, 'enum narrowed');
  }
  const tighter = (k: 'maxLength' | 'maximum' | 'maxItems' | 'exclusiveMaximum', smaller: boolean) => {
    const a = prev[k];
    const b = next[k];
    if (b !== undefined && (a === undefined || (smaller ? b < a : b > a))) add(path, `${k} tightened`);
  };
  tighter('maxLength', true);
  tighter('maximum', true);
  tighter('maxItems', true);
  tighter('exclusiveMaximum', true);
  for (const k of ['minLength', 'minimum', 'minItems', 'exclusiveMinimum'] as const) {
    const a = prev[k];
    const b = next[k];
    if (b !== undefined && (a === undefined || b > a)) add(path, `${k} tightened`);
  }
  if (next.format !== undefined && next.format !== prev.format) add(path, 'format changed');
  if (next.uniqueItems && !prev.uniqueItems) add(path, 'uniqueItems added');
  if (next.multipleOf !== undefined && next.multipleOf !== prev.multipleOf) {
    const widened = prev.multipleOf !== undefined && prev.multipleOf % next.multipleOf === 0;
    if (!widened) add(path, 'multipleOf changed');
  }
  if (next.not !== undefined && next.not !== prev.not) add(path, 'not changed');
  if (next.conditional !== undefined && next.conditional !== prev.conditional)
    add(path, 'conditional changed');
  if (
    next.pattern !== undefined &&
    next.pattern !== prev.pattern &&
    !patternWidens(prev.pattern, next.pattern)
  )
    add(path, 'pattern changed');
  const prevReq = new Set(prev.required ?? []);
  for (const r of next.required ?? []) if (!prevReq.has(r)) add(`${path}.${r}`, 'new required property');
  const pp = prev.properties ?? {};
  const np = next.properties ?? {};
  for (const k of Object.keys(pp)) {
    if (!(k in np)) {
      // A closed object now rejects a property clients were allowed to send.
      if (next.closed) add(`${path}.${k}`, 'property removed');
    } else {
      out.push(...inputBreaks(pp[k] as InputShape, np[k] as InputShape, `${path}.${k}`));
    }
  }
  if (!prev.closed && next.closed && prev.properties !== undefined) add(path, 'object closed');
  if (prev.items && next.items) out.push(...inputBreaks(prev.items, next.items, `${path}[]`));
  if (prev.additional && next.additional)
    out.push(...inputBreaks(prev.additional, next.additional, `${path}{}`));
  else if (!prev.additional && next.additional && prev.properties === undefined && !prev.closed)
    add(`${path}{}`, 'map value constraint added');
  if (prev.anyOf && next.anyOf) {
    // Every alternative a client could use before must still be accepted by some alternative now.
    prev.anyOf.forEach((alt, i) => {
      const accepted = next.anyOf?.some((n) => inputBreaks(alt, n, path).length === 0);
      if (!accepted) add(path, `alternative ${i} no longer accepted`);
    });
  } else if (!prev.anyOf && next.anyOf) add(path, 'alternatives constraint added');
  return out;
}

/**
 * Classifies `next` against `prev`. Returns every change; breaking changes name the field path.
 * Throws when a change cannot be classified, so the pipeline stops instead of assuming additive.
 */
export function classifyChange(prev: Baseline, next: Baseline): Change[] {
  if (prev.version > next.version) throw new Error('baseline version went backwards; cannot classify');
  const out: Change[] = [];
  const nextBy = new Map(next.operations.map((o) => [o.operation, o]));
  const prevBy = new Map(prev.operations.map((o) => [o.operation, o]));
  for (const p of prev.operations) {
    const n = nextBy.get(p.operation);
    const brk = (path: string, reason: string) =>
      out.push({ operation: p.operation, class: 'breaking', path, reason });
    if (!n) {
      brk('$', 'operation removed or renamed');
      continue;
    }
    for (const t of p.transports) if (!n.transports.includes(t)) brk('$', `transport ${t} dropped`);
    if (p.scope !== n.scope) brk('$', `scope changed ${p.scope} -> ${n.scope}`);
    for (const k of p.principals)
      if (!n.principals.includes(k)) brk('$', `principal ${k} no longer admitted`);
    // A-S7: admitting a non-human principal widens who can act (e.g. `service` on a human-only op).
    for (const k of n.principals)
      if (!p.principals.includes(k))
        out.push({
          operation: p.operation,
          class: k === 'human' ? 'additive' : 'breaking',
          path: '$',
          reason: `principal ${k} newly admitted`,
        });
    if (p.idempotency !== undefined && n.idempotency !== undefined && p.idempotency !== n.idempotency) {
      if (n.idempotency === 'required') brk('$', `idempotency ${p.idempotency} -> ${n.idempotency}`);
    }
    if (p.refusals && n.refusals)
      for (const r of n.refusals) if (!p.refusals.includes(r)) brk('$', `new refusal ${r}`);
    if (p.rest && (!n.rest || n.rest.method !== p.rest.method || n.rest.path !== p.rest.path)) {
      brk('$', 'REST method or path changed');
    }
    if (p.mcpTool !== undefined && p.mcpTool !== n.mcpTool) brk('$', 'MCP tool renamed or removed');
    if (p.input && n.input) {
      for (const c of inputBreaks(p.input, n.input)) out.push({ ...c, operation: p.operation });
    } else if (!p.input && n.input && n.input.required && n.input.required.length > 0) {
      brk('$', 'request body now required');
    }
  }
  for (const n of next.operations) {
    if (!prevBy.has(n.operation))
      out.push({ operation: n.operation, class: 'additive', path: '$', reason: 'new operation' });
  }
  return out;
}
