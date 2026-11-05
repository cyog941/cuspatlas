import type { MigrationOp } from './routes/migration-ops';

/**
 * Renders the generated MIGRATION_OPS block of docs/api/openapi.yaml from the operation table and the
 * migration JSON Schema. `scripts/openapi-migration.ts` writes it; the contract drift check renders it
 * again and fails when the committed block differs.
 */
export const MIGRATION_OPS_BLOCK_BEGIN = '  # BEGIN generated: MIGRATION_OPS (scripts/openapi-migration.ts)';
export const MIGRATION_OPS_BLOCK_END = '  # END generated: MIGRATION_OPS';
const SCHEMA = '../../packages/contracts/src/migration.schema.json';

type Defs = Record<string, { properties?: Record<string, { $ref?: string }>; required?: string[] }>;

/** One generated block: its markers, the schema file its $refs point at and the manifest prefix. */
export interface OpsBlockSpec {
  readonly begin: string;
  readonly end: string;
  readonly schema: string;
  readonly prefix: string;
}
export const MIGRATION_OPS_BLOCK: OpsBlockSpec = {
  begin: '  # BEGIN generated: MIGRATION_OPS (scripts/openapi-migration.ts)',
  end: '  # END generated: MIGRATION_OPS',
  schema: SCHEMA,
  prefix: 'migration:',
};

type BlockOp = Pick<
  MigrationOp,
  'method' | 'path' | 'operationId' | 'description' | 'query' | 'requestBody' | 'success' | 'refusals'
>;
const fold = (text: string, indent: string) => {
  const lines: string[] = [];
  let cur = '';
  for (const w of text.split(' ')) {
    if (cur.length + w.length + 1 > 100) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.map((l) => `${indent}${l}`).join('\n');
};

export function renderMigrationOpsBlock(ops: readonly MigrationOp[], defs: Defs): string {
  return renderOpsBlock(ops, defs, MIGRATION_OPS_BLOCK);
}

/** Renders one generated block of docs/api/openapi.yaml for an operation table and its schema. */
export function renderOpsBlock(ops: readonly BlockOp[], defs: Defs, spec: OpsBlockSpec): string {
  const ref = (name: string) => `$ref: '${spec.schema}#/$defs/${name}'`;
  const byPath = new Map<string, string[]>();
  for (const op of ops) {
    const out: string[] = [
      `    ${op.method}:`,
      `      operationId: ${op.operationId}`,
      '      description: >-',
    ];
    out.push(fold(op.description, '        '));
    const params: string[] = [];
    if (op.query) {
      const d = defs[op.query];
      if (!d) throw new Error(`missing query definition ${op.query}`);
      for (const [name, schema] of Object.entries(d.properties ?? {})) {
        params.push(`        - name: ${name}`, '          in: query');
        params.push(`          required: ${(d.required ?? []).includes(name)}`, '          schema:');
        const target = schema.$ref ? schema.$ref.replace('#/$defs/', '') : null;
        params.push(target ? `            ${ref(target)}` : `            ${ref(op.query)}`);
      }
    }
    if (op.method === 'post') params.push("        - $ref: '#/components/parameters/IdempotencyKey'");
    if (params.length) out.push('      parameters:', ...params);
    if (op.requestBody) {
      out.push(
        '      requestBody:',
        '        required: true',
        '        content:',
        '          application/json:',
      );
      out.push('            schema:', `              ${ref(op.requestBody.replace(spec.prefix, ''))}`);
    }
    out.push('      responses:', `        '${op.success.status}':`, '          description: Success.');
    out.push('          content:', '            application/json:', '              schema:');
    out.push(`                ${ref(op.success.schema.replace(spec.prefix, ''))}`);
    for (const r of op.refusals)
      out.push(`        '${r}':`, "          $ref: '#/components/responses/Refusal'");
    const list = byPath.get(op.path) ?? [];
    list.push(...out);
    byPath.set(op.path, list);
  }
  return [spec.begin, ...[...byPath].flatMap(([path, lines]) => [`  ${path}:`, ...lines]), spec.end].join(
    '\n',
  );
}

/** The committed block (between the markers, inclusive), or null when the markers are missing. */
export function extractMigrationOpsBlock(yaml: string): string | null {
  return extractOpsBlock(yaml, MIGRATION_OPS_BLOCK);
}
export function extractOpsBlock(yaml: string, spec: OpsBlockSpec): string | null {
  const a = yaml.indexOf(spec.begin);
  const b = yaml.indexOf(spec.end);
  if (a < 0 || b < a) return null;
  return yaml.slice(a, b + spec.end.length);
}

/** Replaces the committed block or inserts it before `components:`. */
export function spliceMigrationOpsBlock(yaml: string, block: string): string {
  return spliceOpsBlock(yaml, block, MIGRATION_OPS_BLOCK);
}
export function spliceOpsBlock(yaml: string, block: string, spec: OpsBlockSpec): string {
  const begin = yaml.indexOf(spec.begin);
  if (begin >= 0) {
    const end = yaml.indexOf(spec.end) + spec.end.length;
    return yaml.slice(0, begin) + block + yaml.slice(end);
  }
  const at = yaml.indexOf('\ncomponents:');
  return `${yaml.slice(0, at)}\n${block}${yaml.slice(at)}`;
}
