// Regenerates the imaging block of docs/api/openapi.yaml from IMAGING_OPS (between the marker
// comments), so the documented imaging paths are derived from the one operation table. The drift
// check (`contract:check`) still verifies the result independently. Usage: tsx scripts/gen-imaging-openapi.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IMAGING_OPS, pathParamsOf } from '../apps/api/src/index';
import { imagingSchema } from '../packages/contracts/src/index';

const FILE = resolve(import.meta.dirname, '../docs/api/openapi.yaml');
const START = '  # --- imaging (generated from IMAGING_OPS by scripts/gen-imaging-openapi.ts) ---';
const END = '  # --- end imaging ---';
const REF = '../../packages/contracts/src/imaging.schema.json#/$defs/';
const PARAM_DEF: Record<string, string> = {
  objectRef: 'ObjectRef',
  grantRef: 'GrantRef',
  ingressRef: 'IngressRef',
  decisionRef: 'DecisionRef',
  imageRef: 'ImageRef',
  mountRef: 'MountRef',
  annotationRef: 'AnnotationRef',
  legalHoldRef: 'LegalHoldRef',
  deletionRef: 'DeletionRef',
};
const defs = imagingSchema.$defs as Record<
  string,
  { properties?: Record<string, { $ref?: string }>; required?: string[] }
>;

const wrap = (text: string, indent: string) => {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (`${cur} ${w}`.trim().length > 100) {
      lines.push(cur);
      cur = w;
    } else cur = `${cur} ${w}`.trim();
  }
  if (cur) lines.push(cur);
  return lines.map((l) => `${indent}${l}`).join('\n');
};

const byPath = new Map<string, typeof IMAGING_OPS>();
for (const op of IMAGING_OPS) byPath.set(op.path, [...(byPath.get(op.path) ?? []), op]);
const out: string[] = [START];
for (const [path, ops] of byPath) {
  out.push(`  ${path}:`);
  for (const op of ops) {
    out.push(
      `    ${op.method}:`,
      `      operationId: ${op.operationId}`,
      '      description: >-',
      wrap(op.description, '        '),
    );
    const params: string[] = [];
    for (const p of pathParamsOf(op.path)) {
      params.push(
        `        - name: ${p}`,
        '          in: path',
        '          required: true',
        '          schema:',
        `            $ref: '${REF}${PARAM_DEF[p] ?? 'EntityRef'}'`,
      );
    }
    if (op.method === 'post' && op.unkeyed !== true)
      params.push("        - $ref: '#/components/parameters/IdempotencyKey'");
    if (op.restOnly && op.method === 'get') {
      params.push(
        '        - name: x-object-read-token',
        '          in: header',
        '          required: true',
        '          description: Read-grant token from imaging.objects.grantRead; never logged.',
        '          schema:',
        `            $ref: '${REF}ReadGrant/properties/token'`,
      );
    }
    if (op.query) {
      for (const [name, prop] of Object.entries(defs[op.query]?.properties ?? {})) {
        params.push(
          `        - name: ${name}`,
          '          in: query',
          `          required: ${(defs[op.query]?.required ?? []).includes(name)}`,
          '          schema:',
          `            $ref: '${prop.$ref ? `${REF}${prop.$ref.replace('#/$defs/', '')}` : `${REF}${op.query}/properties/${name}`}'`,
        );
      }
    }
    if (params.length > 0) out.push('      parameters:', ...params);
    if (op.requestBody) {
      const media = op.requestMedia ?? 'application/json';
      out.push(
        '      requestBody:',
        '        required: true',
        '        content:',
        `          ${media}:`,
        '            schema:',
        `              $ref: '${REF}${op.requestBody.replace('imaging:', '')}'`,
      );
    }
    out.push(
      '      responses:',
      `        '${op.success.status}':`,
      '          description: Success.',
      '          content:',
      `            ${op.success.media ?? 'application/json'}:`,
      '              schema:',
      `                $ref: '${REF}${op.success.schema.replace('imaging:', '')}'`,
    );
    for (const s of [...op.refusals].sort())
      out.push(`        '${s}':`, "          $ref: '#/components/responses/Refusal'");
  }
}
out.push(END);

let text = readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
const s = text.indexOf(START);
if (s >= 0) {
  const e = text.indexOf(END, s);
  text = text.slice(0, s) + text.slice(e + END.length + 1);
}
const at = text.indexOf('\ncomponents:\n');
text = `${text.slice(0, at + 1)}${out.join('\n')}\n${text.slice(at + 1)}`;
writeFileSync(FILE, text);
process.stdout.write(`imaging openapi block: ${IMAGING_OPS.length} operations\n`);
