// Personal access tokens (PATs) — generation + scope algebra. Storage/auth
// posture mirrors webhook_sources: we persist only sha256(token); the full
// token is shown exactly once at creation. See docs/mcp.md.
import crypto from 'node:crypto';
import { sha256Hex } from './webhook-token';
import {
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKEN_RAW_BYTES,
  ACCESS_TOKEN_DISPLAY_PREFIX_CHARS,
  ACCESS_TOKEN_SCOPES,
} from './constants';

export type AccessTokenScope = (typeof ACCESS_TOKEN_SCOPES)[number];

export interface GeneratedAccessToken {
  token: string;       // full cubex_pat_… — return to the user ONCE, never store
  tokenHash: string;   // sha256(token) hex — the DB lookup key
  tokenPrefix: string; // display-only prefix for the settings list
}

export function generateAccessToken(): GeneratedAccessToken {
  const token = ACCESS_TOKEN_PREFIX + crypto.randomBytes(ACCESS_TOKEN_RAW_BYTES).toString('hex');
  return {
    token,
    tokenHash: sha256Hex(token),
    tokenPrefix: token.slice(0, ACCESS_TOKEN_DISPLAY_PREFIX_CHARS),
  };
}

export { sha256Hex };

// Validate a client-supplied scopes array: known values only, no dups, at
// least one, and 'secrets' never without 'run' (the key-exfiltration gate —
// a secrets-only token must not exist). Returns the canonical comma-set for
// storage, or an error string.
export function validateScopes(input: unknown): string | { scopes: string } {
  if (!Array.isArray(input) || input.length === 0) return 'At least one scope is required';
  const known = new Set<string>(ACCESS_TOKEN_SCOPES);
  const seen = new Set<string>();
  for (const s of input) {
    if (typeof s !== 'string' || !known.has(s)) return `Unknown scope: ${String(s).slice(0, 20)}`;
    seen.add(s);
  }
  if (seen.has('secrets') && !seen.has('run')) return "The 'secrets' scope requires the 'run' scope";
  // Canonical order = declaration order in ACCESS_TOKEN_SCOPES.
  return { scopes: ACCESS_TOKEN_SCOPES.filter(s => seen.has(s)).join(',') };
}

// Expand a stored comma-set into the effective scope set: write/run imply read.
export function expandScopes(stored: string): Set<AccessTokenScope> {
  const out = new Set<AccessTokenScope>();
  const known = new Set<string>(ACCESS_TOKEN_SCOPES);
  for (const s of stored.split(',')) {
    if (known.has(s)) out.add(s as AccessTokenScope);
  }
  if (out.has('write') || out.has('run')) out.add('read');
  return out;
}
