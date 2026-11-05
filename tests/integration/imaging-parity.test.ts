import { IMAGING_OPS } from '@cuspatlas/api';
import { ACTION_POLICIES } from '@cuspatlas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ImagingStack, ingestVia, pngBytes, startImagingStack } from './support/imaging-fixtures';

/**
 * I9 imaging parity matrix, derived from the imaging operation table (REST route manifest) and the
 * live MCP tool list. Every staff operation has a REST route and an MCP tool of the same operation,
 * except byte transports (REST only by the recorded I-T2 decision: MCP never carries bytes); every
 * bridge-facing operation is REST only on the bridge audience (device principals never use MCP). A
 * missing tool, an extra tool, an unregistered route or an operation without a policy fails. Allow,
 * deny and conflict parity per operation is the imaging negative harness; this file adds identical
 * read results on both surfaces.
 */
let s: ImagingStack;
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';

type Surface = 'rest+mcp' | 'rest-only:bytes' | 'rest-only:device-audience';
export interface ParityRow {
  readonly operation: string;
  readonly rest: string;
  readonly mcp: string | null;
  readonly surface: Surface;
}

function surfaceOf(op: (typeof IMAGING_OPS)[number]): Surface {
  if (op.transport !== undefined) return 'rest-only:device-audience';
  if (op.restOnly) return 'rest-only:bytes';
  return 'rest+mcp';
}

beforeAll(async () => {
  s = await startImagingStack('imaging_parity');
  await ingestVia(s, pngBytes(4242));
});
afterAll(async () => {
  await s?.close();
});

describe('I9 imaging parity matrix', () => {
  it('every operation has a policy, a REST route and the MCP surface its decision requires; no extra tool exists', async () => {
    const tools = await s.mcpToolNames('owner');
    const matrix: ParityRow[] = IMAGING_OPS.map((op) => ({
      operation: op.operationId,
      rest: `${op.method.toUpperCase()} ${op.path}`,
      mcp: tools.includes(op.tool) ? op.tool : null,
      surface: surfaceOf(op),
    }));
    for (const row of matrix) {
      const op = IMAGING_OPS.find((o) => o.operationId === row.operation) as (typeof IMAGING_OPS)[number];
      expect([row.operation, row.operation in ACTION_POLICIES]).toStrictEqual([row.operation, true]);
      if (row.surface === 'rest+mcp')
        expect([row.operation, row.mcp]).toStrictEqual([row.operation, op.tool]);
      else expect([row.operation, row.mcp]).toStrictEqual([row.operation, null]);
      if (row.surface === 'rest-only:bytes') {
        const bytes =
          op.requestMedia === 'application/octet-stream' ||
          op.success.media === 'application/octet-stream' ||
          op.operationId === 'imaging.export.blobs';
        expect([row.operation, bytes]).toStrictEqual([row.operation, true]);
      }
      if (row.surface === 'rest-only:device-audience')
        expect([row.operation, op.path.startsWith('/v1/bridge/')]).toStrictEqual([row.operation, true]);
    }
    // No imaging tool without an operation (an extra tool fails too).
    const known = new Set(IMAGING_OPS.map((o) => o.tool));
    expect(tools.filter((t) => t.startsWith('imaging_') && !known.has(t))).toStrictEqual([]);
    // Tool names are unique and every operation name is unique.
    expect(new Set(IMAGING_OPS.map((o) => o.tool)).size).toBe(IMAGING_OPS.length);
    expect(new Set(IMAGING_OPS.map((o) => o.operationId)).size).toBe(IMAGING_OPS.length);
    const counts = {
      operations: matrix.length,
      restAndMcp: matrix.filter((r) => r.surface === 'rest+mcp').length,
      restOnlyBytes: matrix.filter((r) => r.surface === 'rest-only:bytes').length,
      restOnlyDevice: matrix.filter((r) => r.surface === 'rest-only:device-audience').length,
    };
    expect(counts.operations).toBe(counts.restAndMcp + counts.restOnlyBytes + counts.restOnlyDevice);
    expect(counts).toStrictEqual({ operations: 56, restAndMcp: 47, restOnlyBytes: 3, restOnlyDevice: 6 });
  });

  it('every route is registered: without credentials each answers 401, never 404', async () => {
    for (const op of IMAGING_OPS) {
      const url = op.path.replace(/\{[A-Za-z]+\}/g, PLACEHOLDER);
      const res = await s.app.inject({
        method: op.method.toUpperCase() as 'GET' | 'POST',
        url,
        ...(op.method === 'post'
          ? {
              headers: { 'content-type': op.requestMedia ?? 'application/json' },
              payload: op.requestMedia ? Buffer.from([1]) : '{}',
            }
          : {}),
      });
      expect([op.operationId, res.statusCode]).toStrictEqual([op.operationId, 401]);
    }
  });

  it('list reads return the same data on REST and MCP', async () => {
    const reads = IMAGING_OPS.filter(
      (o) => o.method === 'get' && o.transport === undefined && !o.restOnly && !o.path.includes('{'),
    );
    expect(reads.length).toBeGreaterThanOrEqual(6);
    const strip = (v: unknown) => JSON.parse(JSON.stringify(v).replace(/"asOf":"[^"]*"/g, '"asOf":"-"'));
    for (const op of reads) {
      if (op.operationId === 'imaging.export') continue; // exportedAt differs; compared in imaging-export.
      const rest = await s.inject('owner', 'GET', op.path);
      const mcp = await s.mcp('owner', op.tool, {});
      expect([op.operationId, rest.status, mcp.isError]).toStrictEqual([op.operationId, 200, false]);
      expect([op.operationId, strip(mcp.body.data)]).toStrictEqual([op.operationId, strip(rest.json.data)]);
    }
  });
});
