import { Readable } from 'node:stream';
import { RefusalError } from '@cuspatlas/contracts';
import type { PackageBytes, PackageBytesRequest } from '@cuspatlas/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { mapErrorToRefusal } from './errors';

/**
 * Closeout A8: byte delivery of an export package over REST (`practice.export.download`,
 * `exports.download`). The JSON representation stays the default; a request carrying `Range` or
 * `Accept: application/octet-stream` gets the stored package bytes exactly as built:
 *
 * - `ETag: "sha256-<hex>"` and `Repr-Digest: sha-256=:<base64>:` both carry the package digest recorded
 *   at build time (the server re-verifies the stored bytes against it on every request, refusing with
 *   409 `package_integrity_failed` otherwise; a range read may reuse a recent verification of the
 *   unchanged stored file, re-verifying on any change), so a client can resume and verify the file;
 * - a single `Range: bytes=a-b`, `bytes=a-` or `bytes=-n` answers 206 with `Content-Range`; a range
 *   wider than the per-chunk cap is truncated to the cap (the `Content-Range` says what was sent);
 * - multiple ranges, a start at or past the end, or `bytes=-0` answer 416 with `Content-Range: bytes
 *   *\/<total>`; a syntactically invalid or non-`bytes` Range is ignored (RFC 9110) and the whole
 *   package is sent;
 * - `If-Range` that is not the current strong ETag ignores the Range: the whole package, 200;
 * - the whole package is streamed in 64 KiB slices with its `Content-Length`. Closeout E4: the slices
 *   come from the store's streamed read (verified with a streaming hash first, or by a recent
 *   verification of the unchanged file, and hashed again while streaming), so neither a whole
 *   download nor a range behind `If-Range` holds the package in memory.
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

/** The digest an `If-Range` names (our strong ETag form), '' for any other validator. */
const ifRangeDigestOf = (value: string) => /^"sha256-([0-9a-f]{64})"$/.exec(value.trim())?.[1] ?? '';

/**
 * Serves the byte representation. `read(request)` is the domain call (policy, grant, integrity and
 * audit); nothing about the package, its size included, is sent before it returns. A satisfiable
 * `Range` asks the domain for that range only (Closeout C review: a chunk never reads the whole
 * package); with `If-Range` the domain reads the range only when the validator is the recorded digest
 * (Closeout E4). Any other request streams the whole package.
 */
export async function sendPackageBytes(
  request: FastifyRequest,
  reply: FastifyReply,
  read: (request: PackageBytesRequest) => Promise<{ data: PackageBytes }>,
  cap: number,
): Promise<FastifyReply> {
  const rangeHeader = typeof request.headers.range === 'string' ? request.headers.range : undefined;
  const ifRange = request.headers['if-range'];
  // A syntactically ignorable Range is ignorable whatever the size, so it never selects a range.
  const selectable =
    rangeHeader !== undefined && parseByteRange(rangeHeader, Number.MAX_SAFE_INTEGER, cap).kind !== 'none';
  let selected: ByteRange | null = null;
  const { data } = await read(
    selectable
      ? {
          ranged: true,
          stream: true,
          ...(typeof ifRange === 'string' ? { ifRangeDigest: ifRangeDigestOf(ifRange) } : {}),
          range: (total) => {
            selected = parseByteRange(rangeHeader, total, cap);
            return selected.kind === 'range' ? { start: selected.start, end: selected.end + 1 } : null;
          },
        }
      : { ranged: rangeHeader !== undefined, stream: true },
  );
  const etag = `"sha256-${data.digestSha256}"`;
  const total = data.byteLength;
  const bytes = Buffer.from(data.bytes.buffer, data.bytes.byteOffset, data.bytes.byteLength);
  /** Bytes `[start, end]` of the package, whether the domain returned the range or the whole. */
  const slice = (start: number, end: number) =>
    data.offset === undefined
      ? bytes.subarray(start, end + 1)
      : bytes.subarray(start - data.offset, end + 1 - data.offset);
  reply
    .header('accept-ranges', 'bytes')
    .header('etag', etag)
    .header('repr-digest', `sha-256=:${Buffer.from(data.digestSha256, 'hex').toString('base64')}:`)
    .header('cache-control', 'no-store')
    .header('content-disposition', 'attachment')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('referrer-policy', 'no-referrer');
  // The domain selected a range only when one applies (a stale If-Range, or none, is the whole).
  const range: ByteRange = (selected as ByteRange | null) ?? { kind: 'none' };
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
      .send(slice(range.start, range.end));
  }
  return reply
    .code(200)
    .type(OCTET)
    .header('content-length', String(total))
    .send(Readable.from(data.chunks ?? slices(bytes)));
}
