import { isIP } from 'node:net';

// Byte-level, DEFAULT-DENY IP classification for the SSRF guard (outbound-guard.ts).
// Anything we can't confidently parse as a routable *public* address is treated as
// private (=blocked). The earlier string-prefix approach missed representation tricks:
// ::ffff:a9fe:a9fe is 169.254.169.254 (cloud metadata) in hex but doesn't match the
// dotted `::ffff:1.2.3.4` form, and fe90::/fea0::/febf:: are link-local (fe80::/10)
// but don't start with the literal "fe80:". We parse to raw bytes and prefix-match
// CIDRs so the textual form can't matter.

type IPv4Bytes = [number, number, number, number];

function parseIPv4Bytes(ip: string): IPv4Bytes | null {
  const match = ip.match(/^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some(part => part > 255)) return null;
  return parts as IPv4Bytes;
}

// Normalize an IPv6 literal to its 16 bytes. Handles ::-compression and embedded
// IPv4 tails (::ffff:1.2.3.4). Returns null for anything node:net doesn't accept
// as IPv6 or that has a zone id (%eth0) — callers treat null as "reject".
function parseIPv6Bytes(ip: string): number[] | null {
  const lower = ip.toLowerCase();
  if (lower.includes('%') || isIP(lower) !== 6) return null;

  let normalized = lower;
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const v4 = parseIPv4Bytes(normalized.slice(lastColon + 1));
    if (lastColon === -1 || !v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const pieces = normalized.split('::');
  if (pieces.length > 2) return null;
  const compressed = pieces.length === 2;
  const head = pieces[0] ? pieces[0].split(':') : [];
  const tail = pieces[1] ? pieces[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if ((!compressed && fill !== 0) || (compressed && fill < 1)) return null;

  const words = [...head, ...Array(fill).fill('0'), ...tail];
  if (words.length !== 8) return null;

  const bytes: number[] = [];
  for (const word of words) {
    if (!/^[0-9a-f]{1,4}$/.test(word)) return null;
    const value = parseInt(word, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

// True if `bytes` falls inside the CIDR described by `prefix` / `bits`.
function hasPrefix(bytes: number[], prefix: number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  const restBits = bits % 8;
  for (let i = 0; i < fullBytes; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  if (restBits === 0) return true;
  const mask = 0xff << (8 - restBits);
  return (bytes[fullBytes] & mask) === (prefix[fullBytes] & mask);
}

function embeddedIPv4IsPrivate(bytes: number[], offset: number): boolean {
  return isPrivateIPv4(bytes.slice(offset, offset + 4).join('.'));
}

// IPv4: true for ranges users have no legitimate reason to reach. Parse failure
// returns true (default-deny) — an unparseable address is never "confidently public".
export function isPrivateIPv4(ip: string): boolean {
  const parts = parseIPv4Bytes(ip);
  if (!parts) return true;
  const [a, b, c, d] = parts;
  if (a === 0 || a === 10 || a === 127) return true;          // this-net, RFC1918, loopback
  if (a === 100 && b >= 64 && b <= 127) return true;          // carrier-grade NAT (RFC6598)
  if (a === 169 && b === 254) return true;                    // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;           // RFC1918
  if (a === 192 && b === 168) return true;                    // RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol assignments / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;       // benchmarking (RFC2544)
  if (a === 198 && b === 51 && c === 100) return true;        // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;         // TEST-NET-3
  if (a >= 224) return true;                                  // multicast + reserved
  if (a === 255 && b === 255 && c === 255 && d === 255) return true; // broadcast
  return false;
}

// IPv6: loopback/unspecified, link-local (full fe80::/10), ULA, multicast, plus
// the IPv4-carrying transition formats (mapped, NAT64, 6to4) unwrapped + checked.
// Parse failure returns true (default-deny).
export function isPrivateIPv6(ip: string): boolean {
  const bytes = parseIPv6Bytes(ip);
  if (!bytes) return true;
  if (bytes.every(byte => byte === 0)) return true;                                  // :: unspecified
  if (bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1) return true;  // ::1 loopback
  if (hasPrefix(bytes, [0xfe, 0x80], 10)) return true;                               // link-local fe80::/10
  if (hasPrefix(bytes, [0xfc], 7)) return true;                                      // ULA fc00::/7
  if (hasPrefix(bytes, [0xff], 8)) return true;                                      // multicast ff00::/8
  if (hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) {
    return embeddedIPv4IsPrivate(bytes, 12);                                         // IPv4-mapped ::ffff:a.b.c.d
  }
  if (hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0], 96)) return true; // deprecated SIIT ::ffff:0:x
  if (hasPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 96)) return true;       // IPv4-compatible ::a.b.c.d (deprecated)
  if (hasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b], 32)) return true;                   // NAT64 64:ff9b::/32 — covers the /96 well-known + /48 local-use (RFC8215) prefixes, which embed IPv4; nothing public lives here
  if (hasPrefix(bytes, [0x20, 0x02], 16)) return true;                               // 6to4 2002::/16 (embeds IPv4)
  if (hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return true;                   // documentation 2001:db8::/32
  return false;
}

// Single entry point for the guard. We detect the family from the address itself
// via node:net rather than trusting a caller-supplied `family`, so a v4 address
// arriving labelled family 6 (or any representation trick) can't dodge the right
// check. Unrecognized → private (default-deny).
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true;
}
