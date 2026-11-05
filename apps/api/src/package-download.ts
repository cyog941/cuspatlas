import { Readable } from 'node:stream';
import { RefusalError } from '@cuspatlas/contracts';
import type { PackageBytes } from '@cuspatlas/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { mapErrorToRefusal } from './errors';

/**
 * Closeout A8: byte delivery of an export package over REST (`practice.export.download`,
 * `exports.download`). The JSON representation stays the default; a request carrying `Range` or
 * `Accept: application/octet-stream` gets the stored package bytes exactly as built:
 *
 * - `ETag: "sha256-<hex>"` and `Repr-Digest: sha-256=:<base64>:` both carry the package digest recorded
 *   at build time (the server re-verifies the stored bytes against it on every request, refusing with
 *   409 `package_integrity_failed` otherwise), so a client can resume and verify the completed file;
 * - a single `Range: bytes=a-b`, `bytes=a-` or `bytes=-n` answers 206 with `Content-Range`; a range
 *   wider than the per-chunk cap is truncated to the cap (the `Content-Range` says what was sent);
 * - multiple ranges, a start at or past the end, or `bytes=-0` answer 416 with `Content-Range: bytes
 *   *\/<total>`; a syntactically invalid or non-`bytes` Range is ignored (RFC 9110) and the whole
 *   package is sent;
 * - `If-Range` that is not the current strong ETag ignores the Range: the whole package, 200;
 * - the whole package is streamed in 64 KiB slices with its `Content-Length`.
 *
 * Every request (each range included) runs the full policy layer before any byte or size is sent.
 */
export const DEFAULT_DOWNLOAD_CHUNK_BYTES = 1024 * 1024;
const STREAM_SLICE_BYTES = 64 * 1024;
const OCTET = 'application/octet-stream';

export type ByteRange =
  | { readonly kind: 'none' }
  | { readonly kind: 'range'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' };

/** Parses one `Range` header value against the package size and the per-chunk cap. */
export function parseByteRange(header: string, total: number, cap: number): ByteRange {
  const m = /^\s*bytes\s*=\s*(.*?)\s*$/i.exec(header);
  if (!m) return { kind: 'none' };
  const spec = m[1] ?? '';
  if (spec.includes(',')) return { kind: 'unsatisfiable' };
  let start: number;
  let end: number;
  const closed = /^(\d{1,15})-(\d{0,15})$/.exec(spec);
  const suffix = /^-(\d{1,15})$/.exec(spec);
  if (closed) {
    start = Number(closed[1]);
    const last = closed[2] ? Number(closed[2]) : undefined;
    if (last !== undefined && last < start) return { kind: 'none' };
    if (start >= total) return { kind: 'unsatisfiable' };
    end = Math.min(last ?? total - 1, total - 1);
  } else if (suffix) {
    const n = Number(suffix[1]);
    if (n === 0 || total === 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, total - n);
    end = total - 1;
  } else return { kind: 'none' };
  return { kind: 'range', start, end: Math.min(end, start + cap - 1) };
}

/** True when the request asks for the byte representation (a Range, or Accept naming octet-stream). */
export function wantsPackageBytes(request: FastifyRequest): boolean {
  if (typeof request.headers.range === 'string') return true;
  const accept = request.headers.accept;
  return typeof accept === 'string' && accept.toLowerCase().includes(OCTET);
}

function* slices(bytes: Buffer): Generator<Buffer> {
  for (let at = 0; at < bytes.byteLength; at += STREAM_SLICE_BYTES)
    yield bytes.subarray(at, Math.min(at + STREAM_SLICE_BYTES, bytes.byteLength));
}

/**
 * Serves the byte representation. `read(ranged)` is the domain call (policy, grant, integrity and
 * audit); nothing about the package, its size included, is sent before it returns.
 */
export async function sendPackageBytes(
  request: FastifyRequest,
  reply: FastifyReply,
  read: (ranged: boolean) => Promise<{ data: PackageBytes }>,
  cap: number,
): Promise<FastifyReply> {
  const rangeHeader = typeof request.headers.range === 'string' ? request.headers.range : undefined;
  const { data } = await read(rangeHeader !== undefined);
  const etag = `"sha256-${data.digestSha256}"`;
  const total = data.byteLength;
  const bytes = Buffer.from(data.bytes.buffer, data.bytes.byteOffset, data.bytes.byteLength);
  reply
    .header('accept-ranges', 'bytes')
    .header('etag', etag)
    .header('repr-digest', `sha-256=:${Buffer.from(data.digestSha256, 'hex').toString('base64')}:`)
    .header('cache-control', 'no-store')
    .header('content-disposition', 'attachment')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('referrer-policy', 'no-referrer');
  const ifRange = request.headers['if-range'];
  const range =
    rangeHeader === undefined || (typeof ifRange === 'string' && ifRange.trim() !== etag)
      ? ({ kind: 'none' } as const)
      : parseByteRange(rangeHeader, total, cap);
  if (range.kind === 'unsatisfiable') {
    const { body } = mapErrorToRefusal(
      new RefusalError({ code: 'invalid_request', detail: { reason: 'range_not_satisfiable' } }),
      request.id,
    );
    return reply
      .code(416)
      .header('content-range', `bytes */${total}`)
      .type('application/json; charset=utf-8')
      .send(body);
  }
  if (range.kind === 'range') {
    return reply
      .code(206)
      .type(OCTET)
      .header('content-range', `bytes ${range.start}-${range.end}/${total}`)
      .header('content-length', String(range.end - range.start + 1))
      .send(bytes.subarray(range.start, range.end + 1));
  }
  return reply
    .code(200)
    .type(OCTET)
    .header('content-length', String(total))
    .send(Readable.from(slices(bytes)));
}
