import type { BillingOp } from './routes/billing-ops';
import { pathParamsOf } from './routes/scheduling-ops';

/**
 * Renders the generated BILLING_OPS block of docs/api/openapi.yaml from the operation table and the
 * billing JSON Schema. `scripts/openapi-billing.ts` writes it; the contract drift check renders it
 * again and fails when the committed block differs, so the generator and the document cannot drift.
 */
export const BILLING_OPS_BLOCK_BEGIN = '  # BEGIN generated: BILLING_OPS (scripts/openapi-billing.ts)';
export const BILLING_OPS_BLOCK_END = '  # END generated: BILLING_OPS';
const SCHEMA = '../../packages/contracts/src/billing.schema.json';
/** Path parameter -> billing.schema.json definition. */
export const BILLING_PARAM_DEFS: Readonly<Record<string, string>> = {
  procedureRef: 'Uuid',
  chargeRef: 'ChargeRef',
  requestRef: 'Uuid',
  claimRef: 'Uuid',
  appealRef: 'Uuid',
  policyRef: 'Uuid',
  submissionRef: 'Uuid',
  remittanceRef: 'RemittanceRef',
  lineNo: 'RemittanceLineNo',
};

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

export function renderBillingOpsBlock(ops: readonly BillingOp[], defs: Defs): string {
  const byPath = new Map<string, string[]>();
  for (const op of ops) {
    const out: string[] = [
      `    ${op.method}:`,
      `      operationId: ${op.operationId}`,
      '      description: >-',
    ];
    out.push(fold(op.description, '        '));
    const params: string[] = [];
    for (const p of pathParamsOf(op.path)) {
      const def = BILLING_PARAM_DEFS[p];
      if (def === undefined) throw new Error(`no schema definition for path parameter ${p}`);
      params.push(
        `        - name: ${p}`,
        '          in: path',
        '          required: true',
        '          schema:',
      );
      params.push(`            ${ref(def)}`);
    }
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
    if (op.method === 'post' && op.unkeyed !== true)
      params.push("        - $ref: '#/components/parameters/IdempotencyKey'");
    if (params.length) out.push('      parameters:', ...params);
    if (op.requestBody) {
      out.push(
        '      requestBody:',
        '        required: true',
        '        content:',
        '          application/json:',
      );
      out.push('            schema:', `              ${ref(op.requestBody.replace('billing:', ''))}`);
    }
    out.push('      responses:', `        '${op.success.status}':`, '          description: Success.');
    out.push('          content:', '            application/json:', '              schema:');
    out.push(`                ${ref(op.success.schema.replace('billing:', ''))}`);
    for (const r of op.refusals)
      out.push(`        '${r}':`, "          $ref: '#/components/responses/Refusal'");
    const list = byPath.get(op.path) ?? [];
    list.push(...out);
    byPath.set(op.path, list);
  }
  return [
    BILLING_OPS_BLOCK_BEGIN,
    ...[...byPath].flatMap(([path, lines]) => [`  ${path}:`, ...lines]),
    BILLING_OPS_BLOCK_END,
  ].join('\n');
}

/** The committed block (between the markers, inclusive), or null when the markers are missing. */
export function extractBillingOpsBlock(yaml: string): string | null {
  const a = yaml.indexOf(BILLING_OPS_BLOCK_BEGIN);
  const b = yaml.indexOf(BILLING_OPS_BLOCK_END);
  if (a < 0 || b < a) return null;
  return yaml.slice(a, b + BILLING_OPS_BLOCK_END.length);
}

/** Replaces the committed block (any generator comment) or inserts it before `components:`. */
export function spliceBillingOpsBlock(yaml: string, block: string): string {
  const begin = yaml.search(/ {2}# BEGIN generated: BILLING_OPS/);
  if (begin >= 0) {
    const end = yaml.indexOf(BILLING_OPS_BLOCK_END) + BILLING_OPS_BLOCK_END.length;
    return yaml.slice(0, begin) + block + yaml.slice(end);
  }
  const at = yaml.indexOf('\ncomponents:');
  return `${yaml.slice(0, at)}\n${block}${yaml.slice(at)}`;
}
