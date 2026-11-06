import { request as httpRequest } from 'node:http';
import type { PackageBytes } from '@cuspatlas/domain';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { sendPackageBytes } from './package-download';

/**
 * Closeout E review: a streamed whole-package body releases the store's open resource however the
 * response ends: completed, failed mid-stream, or aborted by the client before the first chunk was
 * read. Synthetic bytes only; the server listens on loopback for the duration of one test.
 */
const DIGEST = 'a'.repeat(64);

interface Probe {
  readonly data: PackageBytes;
  readonly closes: () => number;
  readonly pulls: () => number;
  /** Lets the first pull answer (a pull otherwise waits, as a slow disk read would). */
  readonly release: () => void;
}

/** A streamed package whose first pull waits until released; counts pulls and closes. */
function probe(parts: Uint8Array[], opts: { failAfter?: number } = {}): Probe {
  let closes = 0;
  let pulls = 0;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const chunks: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          pulls += 1;
          await gate;
          if (opts.failAfter !== undefined && i >= opts.failAfter) throw new Error('synthetic read failure');
          const value = parts[i++];
          return value === undefined ? { done: true, value: undefined } : { done: false, value };
        },
      };
    },
  };
  return {
    data: {
      bytes: new Uint8Array(0),
      digestSha256: DIGEST,
      byteLength: total,
      chunks,
      close: async () => {
        closes += 1;
      },
    },
    closes: () => closes,
    pulls: () => pulls,
    release: () => open(),
  };
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function serve(p: Probe): Promise<string> {
  app = Fastify();
  app.get('/pkg', (request, reply) => sendPackageBytes(request, reply, async () => ({ data: p.data }), 1024));
  return app.listen({ host: '127.0.0.1', port: 0 });
}

/** Requests the whole package; resolves with the body, or with the error that ended it. */
function fetchAll(url: string): Promise<{ status: number | undefined; body: Buffer; error?: Error }> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    const req = httpRequest(`${url}/pkg`, { headers: { accept: 'application/octet-stream' } }, (res) => {
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts) }));
      res.on('error', (error) => resolve({ status: res.statusCode, body: Buffer.concat(parts), error }));
      res.on('aborted', () =>
        resolve({ status: res.statusCode, body: Buffer.concat(parts), error: new Error('aborted') }),
      );
    });
    req.on('error', (error) => resolve({ status: undefined, body: Buffer.concat(parts), error }));
    req.end();
  });
}

describe('Closeout E review: a streamed package body always closes its store resource', () => {
  it('normal completion closes it once', async () => {
    const p = probe([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
    p.release();
    const url = await serve(p);
    const r = await fetchAll(url);
    expect([r.status, [...r.body]]).toStrictEqual([200, [1, 2, 3, 4, 5]]);
    await expect.poll(() => p.closes(), { timeout: 2000 }).toBeGreaterThan(0);
    expect(p.closes()).toBe(1);
  });

  it('a mid-stream failure closes it', async () => {
    const p = probe([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])], { failAfter: 1 });
    p.release();
    const url = await serve(p);
    const r = await fetchAll(url);
    // The body is cut short; it never completes as the declared length.
    expect(r.body.byteLength).toBeLessThan(5);
    await expect.poll(() => p.closes(), { timeout: 2000 }).toBeGreaterThan(0);
    expect(p.closes()).toBe(1);
  });

  it('a client abort before the first chunk is read closes it', async () => {
    const p = probe([new Uint8Array([1, 2, 3])]);
    const url = await serve(p);
    const req = httpRequest(`${url}/pkg`, { headers: { accept: 'application/octet-stream' } });
    req.on('error', () => undefined);
    req.end();
    // The server is waiting on its first pull (nothing read yet) when the client goes away.
    await expect.poll(() => p.pulls(), { timeout: 2000 }).toBeGreaterThan(0);
    expect([p.pulls(), p.closes()]).toStrictEqual([1, 0]);
    req.destroy();
    await expect.poll(() => p.closes(), { timeout: 2000 }).toBeGreaterThan(0);
    expect(p.closes()).toBe(1);
    // Releasing the pending pull afterwards does not close it again.
    p.release();
    await new Promise((r) => setTimeout(r, 50));
    expect(p.closes()).toBe(1);
  });
});
