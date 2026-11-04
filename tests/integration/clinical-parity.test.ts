import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROUTES } from '@cuspatlas/api';
import { ACTION_POLICIES, CLINICAL_REPLAY_CODECS } from '@cuspatlas/domain';
import { TOOLS } from '@cuspatlas/mcp';
import { describe, expect, it } from 'vitest';

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
const openapi = readFileSync(resolve(__dirname, '../../docs/api/openapi.yaml'), 'utf8');
const harness = readFileSync(resolve(__dirname, 'negative-harness.test.ts'), 'utf8');
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
    documented: openapi.includes(`operationId: ${r.operationId}\n`),
    negativeHarness: harness.includes(`operation: '${r.operationId}'`),
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
    },
  );

  it('no MCP clinical tool exists without a REST route', () => {
    const ops = new Set(routes.map((r) => r.operationId));
    expect(tools.filter((t) => !ops.has(t.operationId)).map((t) => t.name)).toStrictEqual([]);
  });
});
