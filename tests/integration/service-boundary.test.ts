import { buildApp, mapErrorToRefusal } from '@cuspatlas/api';
import { RefusalError } from '@cuspatlas/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MARKER } from '../support/marker';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('service boundary', () => {
  let app: FastifyInstance;
  let logLines: string[];

  beforeEach(async () => {
    logLines = [];
    app = await buildApp({
      env: 'synthetic-test',
      logger: { level: 'trace', stream: { write: (line: string) => logLines.push(line) } },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function assertNoMarker(res: { body: string; headers: Record<string, unknown> }) {
    expect(res.body).not.toContain(MARKER);
    expect(JSON.stringify(res.headers)).not.toContain(MARKER);
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) expect(line).not.toContain(MARKER);
  }

  it('GET /healthz returns exactly {status:"ok"} with a server correlation id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/healthz?probe=${MARKER}`,
      headers: { 'x-request-id': MARKER, 'x-correlation-id': MARKER, authorization: `Bearer ${MARKER}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({ status: 'ok' });
    expect(String(res.headers['x-correlation-id'])).toMatch(UUID);
    assertNoMarker(res);
  });

  it('unknown route returns a typed safe 404 refusal without echoing input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/${MARKER}?q=${MARKER}`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${MARKER}` },
      payload: JSON.stringify({ label: MARKER }),
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(Object.keys(body).sort()).toStrictEqual(['code', 'correlationId', 'retryable']);
    expect(body.code).toBe('not_found');
    expect(body.retryable).toBe(false);
    expect(body.correlationId).toBe(res.headers['x-correlation-id']);
    assertNoMarker(res);
  });

  it('method on a known path that is not routed is the same typed 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/healthz', headers: { 'x-marker': MARKER } });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
    assertNoMarker(res);
  });

  it('maps errors to safe refusals that never carry messages, stacks or payloads', () => {
    const cid = '00000000-0000-4000-8000-000000000001';
    const parseError = Object.assign(new SyntaxError(`Unexpected token in JSON ${MARKER}`), {
      statusCode: 400,
    });
    const unexpected = new Error(`db exploded: select * from secrets where v='${MARKER}'`);
    const tooLarge = Object.assign(new Error(`body ${MARKER}`), {
      statusCode: 413,
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    });
    const typed = new RefusalError({
      code: 'stale_version',
      retryable: false,
      detail: { currentVersion: 3 },
    });

    const cases = [
      [parseError, 400, 'invalid_request'],
      [tooLarge, 400, 'invalid_request'],
      [unexpected, 500, 'internal_error'],
      [typed, 409, 'stale_version'],
      [`a thrown string ${MARKER}`, 500, 'internal_error'],
    ] as const;
    for (const [err, status, code] of cases) {
      const mapped = mapErrorToRefusal(err, cid);
      expect(mapped.status).toBe(status);
      expect(mapped.body.code).toBe(code);
      expect(mapped.body.correlationId).toBe(cid);
      expect(JSON.stringify(mapped)).not.toContain(MARKER);
      expect(JSON.stringify(mapped)).not.toMatch(/stack|select|Unexpected/i);
    }
    expect(mapErrorToRefusal(typed, cid).body.detail).toStrictEqual({ currentVersion: 3 });
  });

  it('refuses to build for an unknown environment name', async () => {
    await expect(buildApp({ env: 'prod-ish' as never })).rejects.toThrow(/environment/);
  });
});
