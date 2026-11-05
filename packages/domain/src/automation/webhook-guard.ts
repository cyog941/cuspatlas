import { isIP } from 'node:net';

/**
 * A14 endpoint guard (SSRF). An endpoint is acceptable only when it is an https URL without
 * credentials, its host (and port; 443 unless the allowlist entry pins another) is on the operator
 * allowlist (A-D7: no arbitrary outbound destination), and neither the host literal nor any address
 * it resolves to is private, loopback, link-local, carrier NAT, unspecified, multicast, documentation
 * or a cloud metadata address. IPv6 forms that embed an IPv4 address (mapped, NAT64, compatible,
 * 6to4) are unwrapped and judged by the IPv4 rules. It runs at registration and again before every
 * send and returns the checked addresses: a transport connects to exactly those (DNS pinning) and
 * never re-resolves the name. It never connects.
 */
export type EndpointRefusal =
  | 'endpoint_invalid'
  | 'endpoint_not_https'
  | 'endpoint_credentials'
  | 'endpoint_not_allowlisted'
  | 'endpoint_port_not_allowed'
  | 'endpoint_private_address';

export type EndpointCheck =
  | {
      readonly ok: true;
      readonly host: string;
      readonly port: number;
      /** The checked public addresses; empty only when a name was not resolved (no resolver). */
      readonly addresses: readonly string[];
    }
  | { readonly ok: false; readonly reason: EndpointRefusal };

const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/;
const METADATA_NAMES = new Set(['metadata', 'metadata.google.internal', 'instance-data']);

function v4Blocked(a: number, b: number, c: number): boolean {
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
    (a === 198 && b === 51 && c === 100) ||
    a >= 224
  );
}

const hexWords = (x: string): number[] =>
  x === '' ? [] : x.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? Number.parseInt(h, 16) : Number.NaN));

/** Parses an IPv6 literal (optionally with an embedded dotted quad or a zone) to 16 bytes. */
export function parseIPv6(ip: string): Uint8Array | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const tail: number[] = [];
  const quad = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (quad) {
    const v4 = quad[2] as string;
    if (isIP(v4) !== 4) return null;
    const [a, b, c, d] = v4.split('.').map(Number) as [number, number, number, number];
    tail.push((a << 8) | b, (c << 8) | d);
    const lead = quad[1] as string;
    s = lead.endsWith('::') ? lead : lead.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = hexWords(halves[0] as string);
  const rest = halves.length === 2 ? hexWords(halves[1] as string) : [];
  const fill = 8 - head.length - rest.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...head, ...new Array<number>(Math.max(fill, 0)).fill(0), ...rest, ...tail];
  if (all.length !== 8 || all.some(Number.isNaN)) return null;
  const out = new Uint8Array(16);
  all.forEach((w, i) => {
    out[2 * i] = w >> 8;
    out[2 * i + 1] = w & 0xff;
  });
  return out;
}

const zero = (b: Uint8Array, from: number, to: number) => b.subarray(from, to).every((x) => x === 0);

function v6Blocked(b: Uint8Array): boolean {
  const v4At = (i: number) => v4Blocked(b[i] as number, b[i + 1] as number, b[i + 2] as number);
  // ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped): the IPv4 rules.
  if (zero(b, 0, 12)) return v4At(12);
  if (zero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return v4At(12);
  // 64:ff9b::/96 NAT64 well-known prefix: the IPv4 rules; 64:ff9b:1::/48 local-use NAT64: blocked.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b)
    return zero(b, 4, 12) ? v4At(12) : true;
  // 2002::/16 6to4: the IPv4 rules on the embedded address.
  if (b[0] === 0x20 && b[1] === 0x02) return v4At(2);
  // 2001::/32 Teredo (obfuscated IPv4) and 2001:db8::/32 documentation.
  if (b[0] === 0x20 && b[1] === 0x01 && ((b[2] === 0 && b[3] === 0) || (b[2] === 0x0d && b[3] === 0xb8)))
    return true;
  // 100::/64 discard.
  if (b[0] === 0x01 && b[1] === 0x00 && zero(b, 2, 8)) return true;
  const b0 = b[0] as number;
  const b1 = b[1] as number;
  // fe80::/10 link-local and fec0::/10 site-local, fc00::/7 unique-local (fd00:ec2::254), ff00::/8 multicast.
  return (b0 === 0xfe && (b1 & 0x80) === 0x80) || (b0 & 0xfe) === 0xfc || b0 === 0xff;
}

/** True when an address literal (v4 or v6, no brackets) must never be a webhook destination. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b, c] = ip.split('.').map(Number) as [number, number, number];
    return v4Blocked(a, b, c);
  }
  if (kind === 6) {
    const bytes = parseIPv6(ip);
    return bytes === null || v6Blocked(bytes);
  }
  return true;
}

/** Allowlist entries: `host` (port 443 only), `host:port`, `[v6]` or `[v6]:port`; a bare v6 means 443. */
function allowlisted(allowlist: readonly string[], host: string, port: number): 'yes' | 'port' | 'no' {
  let hostListed = false;
  for (const raw of allowlist) {
    const e = raw.trim().toLowerCase();
    const m = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(e) ?? /^([^:]+):(\d{1,5})$/.exec(e);
    const h = m ? (m[1] as string) : e;
    const p = m?.[2] ? Number(m[2]) : 443;
    if (h !== host) continue;
    hostListed = true;
    if (p === port) return 'yes';
  }
  return hostListed ? 'port' : 'no';
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
  const literal = isIP(host) !== 0;
  if (literal ? isBlockedAddress(host) : BLOCKED_NAMES.test(host) || METADATA_NAMES.has(host))
    return { ok: false, reason: 'endpoint_private_address' };
  const port = u.port === '' ? 443 : Number(u.port);
  // The URL parser canonicalises IPv6 hosts; compare allowlist v6 entries canonically too.
  const canon = (h: string) =>
    isIP(h) === 6 ? new URL(`https://[${h}]/`).hostname.replace(/^\[|\]$/g, '') : h;
  const listed = allowlisted(
    allowlist.map((e) => {
      const m = /^\[([^\]]+)\](.*)$/.exec(e.trim());
      return m
        ? `[${canon((m[1] as string).toLowerCase())}]${m[2]}`
        : isIP(e.trim()) === 6
          ? `[${canon(e.trim().toLowerCase())}]`
          : e;
    }),
    host,
    port,
  );
  if (listed === 'no') return { ok: false, reason: 'endpoint_not_allowlisted' };
  if (listed === 'port') return { ok: false, reason: 'endpoint_port_not_allowed' };
  return { ok: true, host, port, addresses: literal ? [host] : [] };
}

/**
 * The full guard with name resolution: every resolved address must be public, and the checked set is
 * returned for pinning. Without a resolver a name comes back with no addresses (registration-time
 * literal checks only); the dispatcher never sends without a pinned address, and a network delivery
 * port cannot be composed without a resolver.
 */
export async function guardWebhookEndpoint(
  url: string,
  allowlist: readonly string[],
  resolveHost?: (host: string) => Promise<readonly string[]>,
): Promise<EndpointCheck> {
  const c = checkWebhookEndpoint(url, allowlist);
  if (!c.ok || !resolveHost || c.addresses.length > 0) return c;
  let addresses: readonly string[];
  try {
    addresses = await resolveHost(c.host);
  } catch {
    return { ok: false, reason: 'endpoint_invalid' };
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress))
    return { ok: false, reason: 'endpoint_private_address' };
  return { ...c, addresses: [...addresses] };
}
