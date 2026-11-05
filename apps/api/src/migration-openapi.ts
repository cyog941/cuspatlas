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

const ref = (name: string) => `$ref: '${SCHEMA}#/$defs/${name}'`;
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
      out.push('            schema:', `              ${ref(op.requestBody.replace('migration:', ''))}`);
    }
    out.push('      responses:', `        '${op.success.status}':`, '          description: Success.');
    out.push('          content:', '            application/json:', '              schema:');
    out.push(`                ${ref(op.success.schema.replace('migration:', ''))}`);
    for (const r of op.refusals)
      out.push(`        '${r}':`, "          $ref: '#/components/responses/Refusal'");
    const list = byPath.get(op.path) ?? [];
    list.push(...out);
    byPath.set(op.path, list);
  }
  return [
    MIGRATION_OPS_BLOCK_BEGIN,
    ...[...byPath].flatMap(([path, lines]) => [`  ${path}:`, ...lines]),
    MIGRATION_OPS_BLOCK_END,
  ].join('\n');
}

/** The committed block (between the markers, inclusive), or null when the markers are missing. */
export function extractMigrationOpsBlock(yaml: string): string | null {
  const a = yaml.indexOf(MIGRATION_OPS_BLOCK_BEGIN);
  const b = yaml.indexOf(MIGRATION_OPS_BLOCK_END);
  if (a < 0 || b < a) return null;
  return yaml.slice(a, b + MIGRATION_OPS_BLOCK_END.length);
}

/** Replaces the committed block or inserts it before `components:`. */
export function spliceMigrationOpsBlock(yaml: string, block: string): string {
  const begin = yaml.indexOf(MIGRATION_OPS_BLOCK_BEGIN);
  if (begin >= 0) {
    const end = yaml.indexOf(MIGRATION_OPS_BLOCK_END) + MIGRATION_OPS_BLOCK_END.length;
    return yaml.slice(0, begin) + block + yaml.slice(end);
  }
  const at = yaml.indexOf('\ncomponents:');
  return `${yaml.slice(0, at)}\n${block}${yaml.slice(at)}`;
}
