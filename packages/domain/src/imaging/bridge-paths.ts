/**
 * I6 bridge path rules (server side). A path is data the bridge resolves inside its own configured
 * import root; the server never touches a filesystem path. Accepted: relative segments of
 * [A-Za-z0-9._-] joined by '/', at most 240 characters, NFC, with no '.' or '..' segment. Refused:
 * absolute paths, drive letters, backslashes, control characters, empty segments and traversal. The
 * same rule is a database function (cuspatlas.imaging_safe_bridge_path) so a row cannot bypass it.
 */
const PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export function safeBridgePath(p: unknown): p is string {
  return (
    typeof p === 'string' &&
    p.length >= 1 &&
    p.length <= 240 &&
    p.normalize('NFC') === p &&
    PATH.test(p) &&
    p.split('/').every((s) => s !== '.' && s !== '..')
  );
}

/** True when `path` is one of the prefixes or lies below one (segment-wise, never by substring). */
export function underPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((pre) => path === pre || path.startsWith(`${pre}/`));
}

export const BRIDGE_JOB_KINDS = ['acquire', 'import', 'probe'] as const;
export type BridgeJobKind = (typeof BRIDGE_JOB_KINDS)[number];
