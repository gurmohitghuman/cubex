// Bearer-token auth for the programmatic surface (/api/v1, future /mcp).
// Session-cookie auth is deliberately NOT accepted here — the programmatic
// surface takes tokens only, so no ambient browser credential (and no CSRF
// surface) can ever reach it. The session JWT is never accepted from an
// Authorization: Bearer header; PATs are a separate credential class.
import { Response, NextFunction } from 'express';
import { db } from '../lib/db';
import { AuthRequest } from './auth';
import { expandScopes, sha256Hex, AccessTokenScope } from '../lib/access-token';
import {
  ACCESS_TOKEN_PATTERN,
  ACCESS_TOKEN_LAST_USED_WRITE_INTERVAL_MS,
} from '../lib/constants';

export interface TokenAuthRequest extends AuthRequest {
  accessTokenId?: string;
  accessTokenName?: string;
  tokenScopes?: Set<AccessTokenScope>;
  // 'token' when authenticated by PAT; absent under session-cookie auth. Lets
  // a future shared handler tell the surfaces apart (design doc section 2).
  authMethod?: 'token';
}

// last_used_at throttle: one DB write per token per interval, guarded by an
// in-memory map so token auth stays read-only on the hot path. Per-process is
// fine (api-v1 runs on the main server thread only). The size backstop only
// costs an extra timestamp write per token if it ever trips.
const lastUsedWrites = new Map<string, number>();
const LAST_USED_MAP_MAX = 10_000;

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  scopes: string;
}

// Every failure is the same generic 401 — no oracle distinguishing
// malformed / unknown / revoked / expired (same posture as the webhook 404).
// WWW-Authenticate names the scheme, as RFC 6750 §3 requires on a 401 (no
// resource_metadata: Cubex has no OAuth server for a client to discover).
const unauthorized = (res: Response) =>
  res.status(401).set('WWW-Authenticate', 'Bearer realm="cubex"').json({ error: 'Invalid or missing access token' });

export const authenticateAccessToken = (req: TokenAuthRequest, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  // Auth schemes are case-insensitive (RFC 9110), so "bearer " works too.
  if (typeof header !== 'string' || !/^bearer /i.test(header)) return unauthorized(res);
  const token = header.slice('Bearer '.length).trim();
  // Cheap format check before any hashing/DB work.
  if (!ACCESS_TOKEN_PATTERN.test(token)) return unauthorized(res);

  const row = db.prepare(`
    SELECT id, user_id, name, scopes FROM access_tokens
    WHERE token_hash = ?
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).get(sha256Hex(token)) as TokenRow | undefined;
  if (!row) return unauthorized(res);

  const now = Date.now();
  const last = lastUsedWrites.get(row.id) ?? 0;
  if (now - last > ACCESS_TOKEN_LAST_USED_WRITE_INTERVAL_MS) {
    if (lastUsedWrites.size >= LAST_USED_MAP_MAX) lastUsedWrites.clear();
    lastUsedWrites.set(row.id, now);
    try {
      db.prepare(`UPDATE access_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);
    } catch {
      // Non-fatal: a busy writer must never fail an authenticated request.
    }
  }

  req.userId = row.user_id;
  req.accessTokenId = row.id;
  req.accessTokenName = row.name;
  req.tokenScopes = expandScopes(row.scopes);
  req.authMethod = 'token';
  next();
};

// 403 (authenticated but forbidden), naming the missing scope so an agent can
// tell the user which token setting to change.
export const requireScope = (scope: AccessTokenScope) =>
  (req: TokenAuthRequest, res: Response, next: NextFunction) => {
    if (!req.tokenScopes?.has(scope)) {
      return res.status(403).json({ error: `This action requires the '${scope}' scope` });
    }
    next();
  };
