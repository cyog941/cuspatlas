// Regenerates the READ_OPS block of docs/api/openapi.yaml (foundation schema refs) from the A batch 3
// read-surface table: `corepack pnpm run openapi:read`. Ported from the A3 worker's scratch generator.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathParamsOf, READ_OPS, READ_PARAM_DEFS } from '../apps/api/src/index';

const root = resolve(import.meta.dirname, '..');
const file = resolve(root, 'docs/api/openapi.yaml');
const defs = JSON.parse(
  readFileSync(resolve(root, 'packages/contracts/src/synthetic-task.schema.json'), 'utf8'),
).$defs as Record<string, { properties?: Record<string, { $ref?: string }>; required?: string[] }>;
const BEGIN = '  # BEGIN: READ_OPS (A batch 3 read surfaces)';
const END = '  # END: READ_OPS';
const SCHEMA = '../../packages/contracts/src/synthetic-task.schema.json';
const ref = (n: string) => `$ref: '${SCHEMA}#/$defs/${n}'`;
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
const byPath = new Map<string, string[]>();
for (const op of READ_OPS) {
  const out = [
    `    ${op.method}:`,
    `      operationId: ${op.operationId}`,
    '      description: >-',
    fold(op.description, '        '),
  ];
  const params: string[] = [];
  for (const p of pathParamsOf(op.path))
    params.push(
      `        - name: ${p}`,
      '          in: path',
      '          required: true',
      '          schema:',
      `            ${ref(READ_PARAM_DEFS[p] ?? 'Uuid')}`,
    );
  if (op.query) {
    const d = defs[op.query];
    if (!d) throw new Error(`missing ${op.query}`);
    for (const [name, s] of Object.entries(d.properties ?? {})) {
      const target = s.$ref ? s.$ref.replace('#/$defs/', '') : null;
      params.push(
        `        - name: ${name}`,
        '          in: query',
        `          required: ${(d.required ?? []).includes(name)}`,
        '          schema:',
      );
      params.push(target ? `            ${ref(target)}` : `            ${ref(op.query)}`);
    }
  }
  if (op.method === 'post') params.push("        - $ref: '#/components/parameters/IdempotencyKey'");
  if (params.length) out.push('      parameters:', ...params);
  if (op.requestBody)
    out.push(
      '      requestBody:',
      '        required: true',
      '        content:',
      '          application/json:',
      '            schema:',
      `              ${ref(op.requestBody)}`,
    );
  out.push(
    '      responses:',
    `        '${op.success.status}':`,
    '          description: Success.',
    '          content:',
    '            application/json:',
    '              schema:',
    `                ${ref(op.success.schema)}`,
  );
  for (const r of op.refusals)
    out.push(`        '${r}':`, "          $ref: '#/components/responses/Refusal'");
  byPath.set(op.path, [...(byPath.get(op.path) ?? []), ...out]);
}
const block = [BEGIN, ...[...byPath].flatMap(([p, l]) => [`  ${p}:`, ...l]), END].join('\n');
let yaml = readFileSync(file, 'utf8');
const a = yaml.indexOf(BEGIN);
if (a >= 0) yaml = yaml.slice(0, a) + block + yaml.slice(yaml.indexOf(END) + END.length);
else {
  const at = yaml.indexOf('\ncomponents:');
  yaml = `${yaml.slice(0, at)}\n${block}${yaml.slice(at)}`;
}
writeFileSync(file, yaml);
console.log(`openapi: ${READ_OPS.length} read operations`);
