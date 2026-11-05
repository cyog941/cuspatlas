import { isIP } from 'node:net';

/**
 * A14 endpoint guard (SSRF). An endpoint is acceptable only when it is an https URL without
 * credentials, its host is on the operator allowlist (A-D7: no arbitrary outbound destination), and
 * neither the host literal nor any address it resolves to is private, loopback, link-local, carrier
 * NAT, unspecified, multicast or a cloud metadata address. It runs at registration and again before
 * every send (the allowlist may have shrunk; the name may now resolve elsewhere). It never connects.
 */
export type EndpointRefusal =
  | 'endpoint_invalid'
  | 'endpoint_not_https'
  | 'endpoint_credentials'
  | 'endpoint_not_allowlisted'
  | 'endpoint_private_address';

export type EndpointCheck =
  | { readonly ok: true; readonly host: string }
  | { readonly ok: false; readonly reason: EndpointRefusal };

const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/;
const METADATA_NAMES = new Set(['metadata', 'metadata.google.internal', 'instance-data']);

function v4Blocked(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function v6Blocked(ip: string): boolean {
  const x = ip.toLowerCase();
  if (x === '::' || x === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (mapped) return v4Blocked(mapped[1] as string);
  // fe80::/10 link-local, fc00::/7 unique-local (fd00:ec2::254 metadata included), ff00::/8 multicast.
  return /^(fe[89ab]|f[cd]|ff)/.test(x);
}

/** True when an address literal (v4 or v6, no brackets) must never be a webhook destination. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind === 6) return v6Blocked(ip);
  return true;
}

export function checkWebhookEndpoint(url: string, allowlist: readonly string[]): EndpointCheck {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: 'endpoint_invalid' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'endpoint_not_https' };
  if (u.username !== '' || u.password !== '') return { ok: false, reason: 'endpoint_credentials' };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '' || u.hash !== '') return { ok: false, reason: 'endpoint_invalid' };
  if (isIP(host) !== 0 ? isBlockedAddress(host) : BLOCKED_NAMES.test(host) || METADATA_NAMES.has(host))
    return { ok: false, reason: 'endpoint_private_address' };
  if (!allowlist.map((h) => h.toLowerCase()).includes(host))
    return { ok: false, reason: 'endpoint_not_allowlisted' };
  return { ok: true, host };
}

/**
 * The full guard with name resolution: every resolved address must be public. Without a resolver
 * (synthetic-test without one configured) only the literal checks apply, and that is recorded.
 */
export async function guardWebhookEndpoint(
  url: string,
  allowlist: readonly string[],
  resolveHost?: (host: string) => Promise<readonly string[]>,
): Promise<EndpointCheck> {
  const c = checkWebhookEndpoint(url, allowlist);
  if (!c.ok || !resolveHost || isIP(c.host) !== 0) return c;
  let addresses: readonly string[];
  try {
    addresses = await resolveHost(c.host);
  } catch {
    return { ok: false, reason: 'endpoint_invalid' };
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress))
    return { ok: false, reason: 'endpoint_private_address' };
  return c;
}
