import { RefusalError } from '@cuspatlas/contracts';
import type { PackageBytes } from '@cuspatlas/domain';
import type { Args } from './synthetic-tasks';

/**
 * Closeout C: chunked export download over MCP, the twin of a REST `Range` request on
 * `practice.export.download` and `exports.download`. A call with `chunkOffset` answers one bounded
 * chunk (base64, at most `chunkBytes`, itself at most 1 MiB) with the total length and the package
 * digest recorded at build time. The bytes come from the same domain call a REST range makes, so every
 * chunk repeats the whole policy layer (authorization, envelope, live grant bound to the caller and
 * export, module re-authorization, requester or administrator, a `range` sensitive-read record) and
 * re-verifies the stored bytes against the recorded digest before any byte or size is returned.
 */
export const MAX_MCP_CHUNK_BYTES = 1024 * 1024;

export const CHUNK_PROPERTIES = {
  chunkOffset: {
    type: 'integer',
    minimum: 0,
    maximum: 9007199254740991,
    description:
      'MCP only: answer one chunk of the stored package bytes starting at this byte offset (repeat with nextOffset until it is null).',
  },
  chunkBytes: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_MCP_CHUNK_BYTES,
    description: 'MCP only: the largest chunk to return, at most 1 MiB (default 1 MiB).',
  },
} as const;

export const CHUNK_ARGS = Object.keys(CHUNK_PROPERTIES);

export const CHUNK_DESCRIPTION =
  ' MCP: pass chunkOffset (and optionally chunkBytes, at most 1 MiB) for one base64 chunk of the stored package bytes with totalLength, the recorded digestSha256 and nextOffset; every chunk is re-authorized and re-verified like a REST range.';

/** One chunk of a verified package (the read has run every policy check and the digest check). */
export async function readChunk(
  read: () => Promise<{ data: PackageBytes }>,
  args: Args,
): Promise<{ data: Record<string, unknown> }> {
  const offset = args.chunkOffset as number;
  const max = typeof args.chunkBytes === 'number' ? args.chunkBytes : MAX_MCP_CHUNK_BYTES;
  const { data } = await read();
  const total = data.byteLength;
  if (offset >= total) {
    throw new RefusalError({ code: 'invalid_request', detail: { reason: 'range_not_satisfiable' } });
  }
  const end = Math.min(offset + Math.min(max, MAX_MCP_CHUNK_BYTES), total);
  const bytes = Buffer.from(data.bytes.buffer, data.bytes.byteOffset, data.bytes.byteLength);
  return {
    data: {
      offset,
      length: end - offset,
      totalLength: total,
      digestSha256: data.digestSha256,
      encoding: 'base64',
      chunk: bytes.subarray(offset, end).toString('base64'),
      nextOffset: end < total ? end : null,
    },
  };
}
