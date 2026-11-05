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
  readonly pattern?: string;
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
}

export interface Baseline {
  readonly version: number;
  readonly operations: readonly BaselineOperation[];
}

const MAX_DEPTH = 8;

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
  for (const k of ['maxLength', 'minLength', 'maximum', 'minimum', 'maxItems'] as const) {
    if (typeof node[k] === 'number') out[k] = node[k] as number;
  }
  if (typeof node.pattern === 'string') out.pattern = node.pattern;
  if (isObj(node.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(node.properties)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, summarizeInput(v, doc, depth + 1, seen)]),
    );
    out.closed = node.additionalProperties === false;
  }
  if (Array.isArray(node.required)) out.required = [...(node.required as string[])].sort();
  if (node.items !== undefined) out.items = summarizeInput(node.items, doc, depth + 1, seen);
  const alts = (Array.isArray(node.oneOf) ? node.oneOf : Array.isArray(node.anyOf) ? node.anyOf : null) as
    | unknown[]
    | null;
  if (alts) out.anyOf = alts.map((a) => summarizeInput(a, doc, depth + 1, seen));
  if (Array.isArray(node.allOf)) {
    // Merge conjunctions conservatively: properties and required lists are unioned.
    const parts = (node.allOf as unknown[]).map((a) => summarizeInput(a, doc, depth + 1, seen));
    const props: Record<string, InputShape> = { ...(out.properties ?? {}) };
    const req = new Set(out.required ?? []);
    for (const p of parts) {
      Object.assign(props, p.properties ?? {});
      for (const r of p.required ?? []) req.add(r);
    }
    if (Object.keys(props).length > 0) out.properties = props;
    if (req.size > 0) out.required = [...req].sort();
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
  const tighter = (k: 'maxLength' | 'maximum' | 'maxItems', smaller: boolean) => {
    const a = prev[k];
    const b = next[k];
    if (b !== undefined && (a === undefined || (smaller ? b < a : b > a))) add(path, `${k} tightened`);
  };
  tighter('maxLength', true);
  tighter('maximum', true);
  tighter('maxItems', true);
  for (const k of ['minLength', 'minimum'] as const) {
    const a = prev[k];
    const b = next[k];
    if (b !== undefined && (a === undefined || b > a)) add(path, `${k} tightened`);
  }
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
  if (prev.anyOf && next.anyOf && next.anyOf.length < prev.anyOf.length) add(path, 'alternatives removed');
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
