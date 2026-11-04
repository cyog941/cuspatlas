import { crc32, deflateSync, inflateSync } from 'node:zlib';

/**
 * Minimal PNG codec for synthetic images and server-side derivations (I4), with zero new
 * dependencies. Supports 8-bit grayscale, RGB and RGBA without interlacing; anything else is refused
 * (`unsupported`). Decoding is bounded (dimensions, pixel count, inflated size) so a crafted file
 * cannot exhaust memory. This is not a diagnostic renderer and makes no fidelity claim.
 */
export interface Raster {
  readonly width: number;
  readonly height: number;
  /** Samples per pixel: 1 gray, 3 RGB, 4 RGBA. */
  readonly channels: 1 | 3 | 4;
  readonly pixels: Uint8Array;
}

export class PngError extends Error {
  constructor(readonly reason: 'unsupported' | 'malformed' | 'too_large') {
    super(reason);
    this.name = 'PngError';
  }
}

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SIDE = 8192;
const MAX_PIXELS = 16 * 1024 * 1024;
const COLOR_TYPE: Record<1 | 3 | 4, number> = { 1: 0, 3: 2, 4: 6 };
const CHANNELS: Record<number, 1 | 3 | 4> = { 0: 1, 2: 3, 6: 4 };

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.byteLength, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

export function encodePng(r: Raster): Uint8Array {
  const stride = r.width * r.channels;
  if (r.pixels.byteLength !== stride * r.height) throw new PngError('malformed');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(r.width, 0);
  ihdr.writeUInt32BE(r.height, 4);
  ihdr[8] = 8;
  ihdr[9] = COLOR_TYPE[r.channels];
  const raw = Buffer.alloc((stride + 1) * r.height);
  for (let y = 0; y < r.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(r.pixels.buffer, r.pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return new Uint8Array(
    Buffer.concat([
      SIGNATURE,
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', new Uint8Array(0)),
    ]),
  );
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function decodePng(bytes: Uint8Array): Raster {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.byteLength < 8 || !b.subarray(0, 8).equals(SIGNATURE)) throw new PngError('malformed');
  let off = 8;
  let header: { width: number; height: number; channels: 1 | 3 | 4 } | null = null;
  const idat: Buffer[] = [];
  let ended = false;
  while (off + 12 <= b.byteLength && !ended) {
    const len = b.readUInt32BE(off);
    const type = b.toString('latin1', off + 4, off + 8);
    if (off + 12 + len > b.byteLength) throw new PngError('malformed');
    const data = b.subarray(off + 8, off + 8 + len);
    if (crc32(b.subarray(off + 4, off + 8 + len)) >>> 0 !== b.readUInt32BE(off + 8 + len))
      throw new PngError('malformed');
    if (type === 'IHDR') {
      if (len !== 13) throw new PngError('malformed');
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const channels = CHANNELS[data[9] as number];
      if (data[8] !== 8 || channels === undefined || data[10] !== 0 || data[11] !== 0 || data[12] !== 0)
        throw new PngError('unsupported');
      if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS)
        throw new PngError('too_large');
      header = { width, height, channels };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
    off += 12 + len;
  }
  if (!header || !ended || idat.length === 0) throw new PngError('malformed');
  const stride = header.width * header.channels;
  const expected = (stride + 1) * header.height;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch {
    throw new PngError('malformed');
  }
  if (raw.byteLength !== expected) throw new PngError('malformed');
  const out = new Uint8Array(stride * header.height);
  const bpp = header.channels;
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const v = raw[y * (stride + 1) + 1 + x] as number;
      const a = x >= bpp ? (out[y * stride + x - bpp] as number) : 0;
      const up = y > 0 ? (out[(y - 1) * stride + x] as number) : 0;
      const c = x >= bpp && y > 0 ? (out[(y - 1) * stride + x - bpp] as number) : 0;
      const pred =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? up
              : filter === 3
                ? (a + up) >> 1
                : filter === 4
                  ? paeth(a, up, c)
                  : -1;
      if (pred < 0) throw new PngError('malformed');
      out[y * stride + x] = (v + pred) & 0xff;
    }
  }
  return { ...header, pixels: out };
}

/** A tiny synthetic raster (gradient keyed by a seed) for tests and fixtures; never a radiograph. */
export function syntheticRaster(width: number, height: number, seed = 0): Raster {
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) pixels[y * width + x] = (x * 16 + y * 8 + seed * 37) & 0xff;
  return { width, height, channels: 1, pixels };
}
