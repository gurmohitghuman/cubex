import { promises as dns } from 'node:dns';
import { isPrivateAddress } from './ip-classify';

// SSRF guard for user-supplied outbound URLs (HTTP API enrichment).
//
// The HTTP API column fires any URL the template produces from this server,
// and template values can come from webhook payloads or AI output, not just
// from you. Without this guard a crafted value could target the cloud metadata
// service (169.254.169.254 on AWS/GCP) and leak the host's cloud credentials,
// or probe loopback (127.0.0.1, ::1) and private RFC1918 ranges. We reject
// non-http(s) schemes, then DNS-resolve the hostname and reject any
// private/loopback/link-local/multicast address.
//
// Used by makeHTTPRequest() in lib/http-request.ts. Same guard could be
// applied to the AI web_fetch path if we ever moved that off OpenRouter's
// infra back to our own server.

export interface GuardResult {
  ok: boolean;
  reason?: string;
  // Resolved addresses for the hostname (set on ok:true). The caller MUST
  // pass these to the actual fetch via a pinned lookup, otherwise a second
  // DNS lookup at fetch time could return a different (private) IP — the
  // classic DNS rebinding bypass. Callers use installPinnedLookup() below
  // to wire this into undici's connect options.
  addresses?: Array<{ address: string; family: 4 | 6 }>;
}

// Validates a URL is safe to fetch from this server. Returns ok:false with
// a human-readable reason on failure. Async because hostname resolution does
// a DNS lookup.
export async function checkOutboundUrl(url: string): Promise<GuardResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'Invalid URL.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Only http(s) URLs are allowed (got ${parsed.protocol}).` };
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    return { ok: false, reason: 'URL is missing a hostname.' };
  }

  // DNS-resolve the hostname and check every returned address. A literal IP
  // in the URL gets caught here too (dns.lookup just returns it as-is).
  // We resolve ALL addresses — not just the first — because a hostname can
  // round-robin between public and private IPs and we'd be fooled by the
  // happy-path resolution.
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    return { ok: false, reason: `Could not resolve ${hostname}.` };
  }

  for (const { address } of addresses) {
    // Classify by the address bytes themselves, not dns.lookup's reported family —
    // representation tricks (e.g. an IPv4-mapped v6 form) can't dodge the check.
    if (isPrivateAddress(address)) {
      return {
        ok: false,
        reason: `${hostname} resolves to a private/internal address (${address}). ` +
          `Cubex doesn't fetch internal URLs from user-supplied templates.`,
      };
    }
  }

  return {
    ok: true,
    addresses: addresses.map(a => ({ address: a.address, family: a.family as 4 | 6 })),
  };
}

// Build a Node `lookup` function that returns the addresses we already
// validated, instead of doing a fresh DNS query. Pass into undici via
// `dispatcher: new Agent({ connect: { lookup: ... } })` or similar.
//
// Without this, the runner does:
//   1. checkOutboundUrl() — resolves to public IP, passes guard
//   2. undici.request()   — does ITS OWN DNS lookup, may get private IP
// An attacker-controlled DNS server can return different answers on the
// two queries (DNS rebinding). Pinning the lookup eliminates the gap.
export function pinnedLookup(addresses: Array<{ address: string; family: 4 | 6 }>) {
  // Signature matches Node's dns.LookupFunction. opts is loosely typed
  // because the actual LookupOptions type allows family as `number |
  // 'IPv4' | 'IPv6'`; we coerce.
  return (
    _hostname: string,
    opts: any,
    cb: (err: NodeJS.ErrnoException | null, addressOrAddresses?: any, family?: number) => void,
  ) => {
    const wantFamilyRaw = opts?.family;
    const wantFamily =
      wantFamilyRaw === 4 || wantFamilyRaw === 'IPv4' ? 4 :
      wantFamilyRaw === 6 || wantFamilyRaw === 'IPv6' ? 6 :
      undefined;
    const filtered = wantFamily
      ? addresses.filter(a => a.family === wantFamily)
      : addresses;
    if (filtered.length === 0) {
      const err: NodeJS.ErrnoException = new Error('ENOTFOUND') as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      cb(err);
      return;
    }
    if (opts?.all) {
      cb(null, filtered.map(a => ({ address: a.address, family: a.family })));
    } else {
      cb(null, filtered[0].address, filtered[0].family);
    }
  };
}
