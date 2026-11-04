import type { ImagingContentType } from '@cuspatlas/contracts';

/**
 * Media sniffing by magic bytes (I2). The declared media type and the file name are never trusted:
 * only these signatures are recognized, anything else is `null` (quarantined as unrecognized).
 * DICOM is recognized only by its `DICM` preamble marker and is stored opaquely (no parsing; I5 and
 * I-S2 are deferred).
 */
const startsWith = (b: Uint8Array, sig: readonly number[], at = 0) =>
  b.byteLength >= at + sig.length && sig.every((x, i) => b[at + i] === x);

export function sniffContentType(bytes: Uint8Array): ImagingContentType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]))
    return 'image/tiff';
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(bytes, [0x44, 0x49, 0x43, 0x4d], 128)) return 'application/dicom';
  return null;
}

/** True when the IANA zone is known to this runtime's zone database. */
export function knownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A display name that is only dots (".", "..") would read as a path segment; refused. */
export const dotOnlyName = (name: string) => /^\.+$/.test(name.trim());
