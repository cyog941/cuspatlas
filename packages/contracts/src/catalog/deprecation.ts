import type { DeprecationEntry } from './catalog';
import published from './deprecations.json' with { type: 'json' };

/**
 * A5 deprecation markers. A deprecated operation still answers and still audits; its REST responses
 * carry `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) headers and its MCP results a notice.
 */
export const DEPRECATIONS: readonly DeprecationEntry[] = published as readonly DeprecationEntry[];

export function deprecationIndex(
  entries: readonly DeprecationEntry[] = DEPRECATIONS,
): ReadonlyMap<string, DeprecationEntry> {
  return new Map(entries.map((e) => [e.operation, e]));
}

const SUNSET_REGISTER = '/docs/api/sunset-register.md';

export function deprecationHeaders(e: DeprecationEntry): Record<string, string> {
  const announced = Math.floor(Date.parse(`${e.announced}T00:00:00Z`) / 1000);
  return {
    deprecation: `@${announced}`,
    sunset: new Date(`${e.sunset}T00:00:00Z`).toUTCString(),
    link: `<${SUNSET_REGISTER}>; rel="deprecation"`,
  };
}

export function deprecationNotice(e: DeprecationEntry): {
  readonly deprecated: true;
  readonly sunset: string;
  readonly replacedBy: string | null;
  readonly notice: string;
} {
  return {
    deprecated: true,
    sunset: e.sunset,
    replacedBy: e.replacedBy,
    notice: `Deprecated since ${e.announced}; may be removed after ${e.sunset}. ${
      e.replacedBy ? `Use ${e.replacedBy}.` : 'No replacement exists.'
    }`,
  };
}
