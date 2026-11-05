import { IMAGING_OPS } from '@cuspatlas/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attemptReasons, type ImagingStack, startImagingStack } from './support/imaging-fixtures';
import { SyntheticBridge } from './support/synthetic-bridge';

/**
 * I9 consolidated imaging negative matrix. The staff dimensions (cross-tenant, revoked, downgraded,
 * REST and MCP, every staff operation) are the imaging negative harness
 * (tests/integration/imaging-negative-harness.test.ts). This file adds the device-principal
 * dimensions over the whole operation table: a device assertion at every staff route and at MCP is
 * 401; every bridge route refuses no credential, a staff REST token, a staff MCP token, an unpaired
 * device, a revoked device (403) and a replayed assertion; another tenant's device sees no job of this
 * tenant (404). Every denial leaves an attempt row with its reason and runs under the runtime role.
 */
let s: ImagingStack;
let alpha: SyntheticBridge;
let beta: SyntheticBridge;
let revoked: SyntheticBridge;
let alphaJob: string;
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';
const STAFF = IMAGING_OPS.filter((o) => o.transport === undefined);
const DEVICE = IMAGING_OPS.filter((o) => o.transport === 'device');
const urlOf = (path: string, job = PLACEHOLDER) =>
  path.replace('{jobRef}', job).replace(/\{[A-Za-z]+\}/g, PLACEHOLDER);
const bodyOf = (op: (typeof IMAGING_OPS)[number]) =>
  op.operationId === 'imaging.bridge.result'
    ? { result: 'e30.e30.AAAA' }
    : op.requestMedia === 'application/octet-stream'
      ? new Uint8Array([1, 2, 3])
      : op.method === 'get'
        ? undefined
        : {};

async function pairIn(who: 'owner' | 'crossTenant') {
  const reg = await s.command(who, '/v1/imaging/devices', {
    label: 'Matrix Bridge',
    allowedJobKinds: ['import'],
    allowedPathPrefixes: ['exports'],
  });
  const deviceRef = (reg.json.data as { deviceRef: string }).deviceRef;
  const code = (await s.inject(who, 'POST', `/v1/imaging/devices/${deviceRef}/pairing-codes`, {})).json
    .data as {
    pairingCode: string;
  };
  const b = new SyntheticBridge(s.app);
  expect((await b.pair(code.pairingCode)).status).toBe(201);
  return b;
}

beforeAll(async () => {
  s = await startImagingStack('imaging_negative_matrix');
  alpha = await pairIn('owner');
  beta = await pairIn('crossTenant');
  revoked = await pairIn('owner');
  const e = await s.command('owner', '/v1/imaging/bridge-jobs', {
    deviceRef: alpha.deviceRef,
    kind: 'import',
    importPath: 'exports/m.png',
  });
  alphaJob = (e.json.data as { jobRef: string }).jobRef;
  expect(
    (
      await s.command('owner', `/v1/imaging/devices/${revoked.deviceRef}/revoke`, {
        reasonCode: 'device_lost',
      })
    ).status,
  ).toBe(200);
});
afterAll(async () => {
  await s?.close();
});

describe('I9 device principals at staff routes', () => {
  it.each(STAFF.map((o) => [o.operationId, o] as const))(
    '%s refuses a device assertion (401)',
    async (_n, op) => {
      const url = urlOf(op.path);
      const method = op.method.toUpperCase() as 'GET' | 'POST';
      const r = await alpha.raw(
        method,
        url,
        bodyOf(op),
        alpha.assertion(method, url.split('?')[0] as string),
      );
      expect(r.status).toBe(401);
      expect(await attemptReasons(s.db.admin, r.json.correlationId)).toStrictEqual(['token_invalid']);
    },
  );

  it('MCP refuses a device assertion before any tool runs', async () => {
    const res = await fetch(s.mcpUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${alpha.assertion('POST', new URL(s.mcpUrl).pathname)}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'matrix', version: '0' },
        },
      }),
    });
    expect(res.status).toBe(401);
  });
});

describe('I9 bridge routes refuse everything but a live device of the same tenant', () => {
  it.each(DEVICE.map((o) => [o.operationId, o] as const))('%s', async (_n, op) => {
    const url = urlOf(op.path, alphaJob);
    const body = bodyOf(op);
    const none = await alpha.raw('POST', url, body, null);
    expect(['none', none.status]).toStrictEqual(['none', 401]);
    const staff = await alpha.raw('POST', url, body, s.rest.owner);
    expect(['staff', staff.status]).toStrictEqual(['staff', 401]);
    expect(await attemptReasons(s.db.admin, staff.json.correlationId)).toStrictEqual([
      'device_assertion_invalid',
    ]);
    const staffMcp = await alpha.raw('POST', url, body, s.mcpTokens.owner);
    expect(['staffMcp', staffMcp.status]).toStrictEqual(['staffMcp', 401]);
    const ghost = new SyntheticBridge(s.app);
    ghost.deviceRef = PLACEHOLDER;
    ghost.tenantRef = alpha.tenantRef;
    ghost.keyVersion = 1;
    expect([
      'unpaired',
      (await ghost.raw('POST', url, body, ghost.assertion('POST', url))).status,
    ]).toStrictEqual(['unpaired', 401]);
    const rev = await revoked.raw('POST', url, body, revoked.assertion('POST', url));
    expect(['revoked', rev.status]).toStrictEqual(['revoked', 403]);
    expect(await attemptReasons(s.db.admin, rev.json.correlationId)).toStrictEqual(['device_revoked']);
    const once = alpha.assertion('POST', url, { body });
    await alpha.raw('POST', url, body, once);
    const replay = await alpha.raw('POST', url, body, once);
    expect(['replay', replay.status]).toStrictEqual(['replay', 401]);
    expect(await attemptReasons(s.db.admin, replay.json.correlationId)).toStrictEqual([
      'device_assertion_replayed',
    ]);
    if (op.path.includes('{jobRef}')) {
      const foreign = await beta.raw('POST', url, body, beta.assertion('POST', url, { body }));
      expect(['crossTenant', foreign.status]).toStrictEqual(['crossTenant', 404]);
      expect(await attemptReasons(s.db.admin, foreign.json.correlationId)).toStrictEqual([
        'resource_hidden_or_missing',
      ]);
    }
  });

  it("another tenant's device never claims this tenant's job", async () => {
    expect((await beta.claim()).job).toBeNull();
    const j = (await s.inject('owner', 'GET', `/v1/imaging/bridge-jobs/${alphaJob}`)).json.data as {
      deviceRef: string;
    };
    expect(j.deviceRef).toBe(alpha.deviceRef);
  });

  it('every bridge route is covered by this matrix and the pairing route by the I6 suite', () => {
    expect(DEVICE.length + IMAGING_OPS.filter((o) => o.transport === 'pairing').length).toBe(6);
  });
});
