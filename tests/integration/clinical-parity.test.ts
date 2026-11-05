import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROUTES } from '@cuspatlas/api';
import { ACTION_POLICIES, CLINICAL_REPLAY_CODECS } from '@cuspatlas/domain';
import { TOOLS } from '@cuspatlas/mcp';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { documentedOperations } from '../../apps/api/src/contract-drift';

/**
 * C18: the clinical parity matrix, derived (never hand-listed) from the clinical route manifest and
 * the MCP tool list. For every clinical operation it records the REST route, the MCP tool, the policy
 * (scope and principals), whether it is a command with a replay codec, its OpenAPI documentation and
 * its negative-harness row. A route without exactly one tool, a tool without a route, an undocumented
 * operation or one missing from the negative harness fails. The matrix is written to
 * artifacts/clinical-parity-matrix.json (generated evidence, not committed).
 */
const routes = ROUTES.filter((r) => r.operationId.startsWith('clinical.'));
const tools = TOOLS.filter((t) => t.operationId.startsWith('clinical.'));
const documented = documentedOperations(
  readFileSync(resolve(__dirname, '../../docs/api/openapi.yaml'), 'utf8'),
);

/**
 * The negative-harness rows, read from the harness source's syntax tree (importing the test file would
 * run it): every object literal that is an element of `COMMANDS`, directly or inside a row function
 * spread into it, with its `operation`, `tool`, `crossTenant`, `downgradedTo`, `rest` and `mcpArgs`.
 * A mention of an operation id anywhere else in the file does not count.
 */
function harnessRows(): Map<string, string[]> {
  const file = resolve(__dirname, 'negative-harness.test.ts');
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const functions = new Map<string, ts.Node>();
  let commands: ts.ArrayLiteralExpression | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name) functions.set(n.name.text, n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      if (n.name.text === 'COMMANDS' && ts.isArrayLiteralExpression(n.initializer)) commands = n.initializer;
      else if (ts.isArrowFunction(n.initializer)) functions.set(n.name.text, n.initializer);
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  const rows = new Map<string, string[]>();
  const prop = (o: ts.ObjectLiteralExpression, name: string) =>
    o.properties.find((p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === name);
  const literal = (o: ts.ObjectLiteralExpression, name: string) => {
    const p = prop(o, name);
    return p && ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer)
      ? p.initializer.text
      : null;
  };
  const take = (o: ts.ObjectLiteralExpression) => {
    const operation = literal(o, 'operation');
    const tool = literal(o, 'tool');
    if (operation === null || tool === null || literal(o, 'crossTenant') === null) return;
    if (literal(o, 'downgradedTo') === null || !prop(o, 'rest') || !prop(o, 'mcpArgs')) return;
    rows.set(operation, [...(rows.get(operation) ?? []), tool]);
  };
  const rowsIn = (n: ts.Node) => {
    if (ts.isArrayLiteralExpression(n)) {
      for (const e of n.elements) if (ts.isObjectLiteralExpression(e)) take(e);
    }
    ts.forEachChild(n, rowsIn);
  };
  if (!commands) throw new Error('negative harness COMMANDS table not found');
  for (const e of commands.elements) {
    if (ts.isObjectLiteralExpression(e)) take(e);
    else if (
      ts.isSpreadElement(e) &&
      ts.isCallExpression(e.expression) &&
      ts.isIdentifier(e.expression.expression)
    ) {
      const fn = functions.get(e.expression.expression.text);
      if (!fn) throw new Error(`negative harness row function ${e.expression.expression.text} not found`);
      rowsIn(fn);
    } else if (ts.isSpreadElement(e)) {
      // Workstream B rows: a spread of [operation, tool, ...] tuples mapped to harness rows.
      const tuples = (n: ts.Node) => {
        if (ts.isArrayLiteralExpression(n)) {
          const [op, tool] = n.elements;
          if (
            op &&
            tool &&
            ts.isStringLiteral(op) &&
            ts.isStringLiteral(tool) &&
            /^[a-z]+.[A-Za-z.]+$/.test(op.text)
          )
            rows.set(op.text, [...(rows.get(op.text) ?? []), tool.text]);
        }
        ts.forEachChild(n, tuples);
      };
      rowsIn(e);
      tuples(e);
    } else throw new Error('unrecognized element in the negative harness COMMANDS table');
  }
  return rows;
}
const harness = harnessRows();

const policies = ACTION_POLICIES as Record<string, { scope: string | null; principals: readonly string[] }>;
const codecs = CLINICAL_REPLAY_CODECS as Record<string, unknown>;

interface Row {
  operationId: string;
  method: string;
  path: string;
  tool: string | null;
  toolCount: number;
  toolReadOnly: boolean | null;
  scope: string | null;
  principals: readonly string[];
  command: boolean;
  replayCodec: boolean;
  documented: boolean;
  negativeHarness: boolean;
  harnessTool: string | null;
}

const matrix: Row[] = routes.map((r) => {
  const matching = tools.filter((t) => t.operationId === r.operationId);
  const policy = policies[r.operationId];
  return {
    operationId: r.operationId,
    method: r.method,
    path: r.path,
    tool: matching[0]?.name ?? null,
    toolCount: matching.length,
    toolReadOnly: matching[0] ? matching[0].readOnly : null,
    scope: policy?.scope ?? null,
    principals: policy?.principals ?? [],
    command: r.method === 'post',
    replayCodec: r.operationId in codecs,
    documented:
      documented.filter((d) => d.operationId === r.operationId && d.method === r.method && d.path === r.path)
        .length === 1,
    negativeHarness: (harness.get(r.operationId) ?? []).length === 1,
    harnessTool: harness.get(r.operationId)?.[0] ?? null,
  };
});

describe('C18 clinical parity matrix (derived from the route manifest and the MCP tool list)', () => {
  it('covers every clinical route and is written as evidence', () => {
    expect(matrix.length).toBeGreaterThanOrEqual(80);
    const dir = resolve(__dirname, '../../artifacts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'clinical-parity-matrix.json'),
      `${JSON.stringify({ generatedBy: 'tests/integration/clinical-parity.test.ts', size: matrix.length, matrix }, null, 2)}\n`,
    );
  });

  it.each(matrix.map((m) => [m.operationId, m] as const))(
    '%s has REST, MCP, policy, docs and the negative harness',
    (_op, m) => {
      // A missing (or duplicated) tool fails the matrix.
      expect([m.operationId, m.toolCount]).toStrictEqual([m.operationId, 1]);
      expect([m.operationId, m.toolReadOnly]).toStrictEqual([m.operationId, !m.command]);
      expect([
        m.operationId,
        m.scope === null ? null : /^(clinical\.(read|write|sign|oversight)|admin\.configure)$/.test(m.scope),
      ]).toStrictEqual([m.operationId, true]);
      // Human-only clinical authorship: no clinical command may be executed by a service principal.
      if (m.command) expect([m.operationId, m.principals]).toStrictEqual([m.operationId, ['human']]);
      if (m.command) expect([m.operationId, m.replayCodec]).toStrictEqual([m.operationId, true]);
      expect([m.operationId, m.documented, m.negativeHarness]).toStrictEqual([m.operationId, true, true]);
      // The harness row drives the same MCP tool the matrix names.
      expect([m.operationId, m.harnessTool]).toStrictEqual([m.operationId, m.tool]);
    },
  );

  it('the harness and OpenAPI readers see real rows only (a substring elsewhere does not count)', () => {
    expect(harness.size).toBeGreaterThanOrEqual(matrix.length);
    expect(harness.has('clinical.notARealOperation')).toBe(false);
    expect(documented.length).toBeGreaterThanOrEqual(matrix.length);
  });

  it('no MCP clinical tool exists without a REST route', () => {
    const ops = new Set(routes.map((r) => r.operationId));
    expect(tools.filter((t) => !ops.has(t.operationId)).map((t) => t.name)).toStrictEqual([]);
  });
});
