/**
 * Synthetic DICOM-like containers for the I5 boundary tests (test-only, generated in memory). They
 * carry the 128-byte preamble and the `DICM` marker and a few explicit-VR little-endian elements with
 * synthetic values. They are not conformance samples (I-S2 is blocked-on-discovery) and are never a
 * real study, a vendor sample or a clinic export.
 */
const te = new TextEncoder();

function element(group: number, el: number, vr: string, value: Uint8Array, lengthOverride?: number) {
  const long = ['OB', 'OW', 'OF', 'SQ', 'UT', 'UN'].includes(vr);
  const head = new Uint8Array(long ? 12 : 8);
  const v = new DataView(head.buffer);
  v.setUint16(0, group, true);
  v.setUint16(2, el, true);
  head[4] = vr.charCodeAt(0);
  head[5] = vr.charCodeAt(1);
  if (long) v.setUint32(8, lengthOverride ?? value.byteLength, true);
  else v.setUint16(6, lengthOverride ?? value.byteLength, true);
  return [head, value];
}

const even = (s: string) => te.encode(s.length % 2 === 0 ? s : `${s} `);

export interface SyntheticDicomOptions {
  readonly patientName?: string;
  readonly patientId?: string;
  /** Adds a pixel-data element whose declared length is absurd (parser budget case). */
  readonly absurdLength?: boolean;
  /** Adds a referenced-file element pointing outside any root (external reference case). */
  readonly externalReference?: string;
  /** Varies the bytes (distinct digests). */
  readonly seed?: number;
}

export function syntheticDicom(o: SyntheticDicomOptions = {}): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array(128), te.encode('DICM')];
  parts.push(...element(0x0002, 0x0010, 'UI', even('1.2.840.10008.1.2.1')));
  parts.push(...element(0x0008, 0x0060, 'CS', even('IO')));
  parts.push(...element(0x0010, 0x0010, 'PN', even(o.patientName ?? 'SYNTHETIC^PATIENT')));
  parts.push(...element(0x0010, 0x0020, 'LO', even(o.patientId ?? 'SYN-0001')));
  parts.push(...element(0x0020, 0x0013, 'IS', even(String(o.seed ?? 1))));
  if (o.externalReference) parts.push(...element(0x0004, 0x1500, 'CS', even(o.externalReference)));
  if (o.absurdLength) parts.push(...element(0x7fe0, 0x0010, 'OB', new Uint8Array(16), 0xfffffff0));
  const n = parts.reduce((a, p) => a + p.byteLength, 0);
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** The marker at the wrong offset: not recognized as a container by magic bytes. */
export function misplacedMarker(): Uint8Array {
  const out = new Uint8Array(200);
  out.set(te.encode('DICM'), 0);
  return out;
}

/** Preamble and marker followed by bytes that are not a valid element stream. */
export function malformedDicom(seed = 7): Uint8Array {
  const out = new Uint8Array(128 + 4 + 64);
  out.set(te.encode('DICM'), 128);
  for (let i = 132; i < out.length; i += 1) out[i] = (i * 31 + seed) & 0xff;
  return out;
}
