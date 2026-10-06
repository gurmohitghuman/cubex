// One-time links that move a CSV file into or out of a sheet over plain HTTP,
// so an MCP agent on any machine can import or export a file of any size
// without its contents passing through the agent's context: the agent asks for
// a link (mcp/tools-links.ts) and runs the curl command it gets back
// (routes/file-links.ts).
//
// Like a presigned URL, the link is the credential, so it is as narrow as it
// can be: 32 random bytes with only their sha256 stored (a database leak yields
// no working link), one sheet, one operation the minting token can already do
// (upload: write, download: read), one use, FILE_LINK_TTL_MINUTES, and it stops
// working when that token is revoked or expires. It hands over one call; it is
// not a new credential (a token still can't mint tokens).
import crypto from 'crypto';
import type { Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { sha256Hex } from './webhook-token';
import { isHttps } from './cookie';
import { FILE_LINK_TTL_MINUTES } from './api-v1-constants';

export type FileLinkKind = 'upload' | 'download';
export interface FileLink { id: string; user_id: string; sheet_id: string; options: string }

// SQLite's datetime('now') format, so expires_at compares as text.
const sqlTime = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');

export function createFileLink(args: {
  userId: string; tokenId: string; sheetId: string; kind: FileLinkKind; options: Record<string, unknown>;
}): { token: string; expiresAt: string } {
  // Expired links are dead weight: clear them out as new ones are made. A used
  // link stays until it expires, since an upload still in progress may hand it
  // back (releaseFileLink).
  db.prepare(`DELETE FROM file_links WHERE user_id = ? AND expires_at <= datetime('now')`).run(args.userId);
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + FILE_LINK_TTL_MINUTES * 60_000);
  db.prepare(`
    INSERT INTO file_links (id, user_id, access_token_id, sheet_id, kind, token_hash, options, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), args.userId, args.tokenId, args.sheetId, args.kind, sha256Hex(token),
    JSON.stringify(args.options), sqlTime(expires));
  return { token, expiresAt: expires.toISOString() };
}

// The link behind `token` if it can still be used: this kind, unused,
// unexpired, and made by an access token that is still valid. Marks nothing.
export function findFileLink(token: string, kind: FileLinkKind): FileLink | null {
  const link = db.prepare(`
    SELECT l.id, l.user_id, l.sheet_id, l.options FROM file_links l
    JOIN access_tokens t ON t.id = l.access_token_id AND t.user_id = l.user_id
    WHERE l.token_hash = ? AND l.kind = ? AND l.used_at IS NULL AND l.expires_at > datetime('now')
      AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
  `).get(sha256Hex(token), kind) as FileLink | undefined;
  return link ?? null;
}

// Marks the link used; false when another request already did.
export function useFileLink(link: FileLink): boolean {
  return db.prepare(`UPDATE file_links SET used_at = datetime('now') WHERE id = ? AND user_id = ? AND used_at IS NULL`)
    .run(link.id, link.user_id).changes === 1;
}

// Hands a used link back, for an upload refused because its sheet was busy:
// nothing was imported, so the same link may try again until it expires.
// False when there was nothing to hand back (the link has since expired).
export function releaseFileLink(link: FileLink): boolean {
  return db.prepare(`UPDATE file_links SET used_at = NULL WHERE id = ? AND user_id = ? AND expires_at > datetime('now')`)
    .run(link.id, link.user_id).changes === 1;
}

export function linkOptions<T>(link: FileLink): Partial<T> {
  try { return JSON.parse(link.options) as Partial<T>; } catch { return {}; }
}

// Where links handed to a caller point: PUBLIC_URL when set (as for webhook
// URLs), else the scheme and host this request reached Cubex on, since the
// caller demonstrably gets there.
const HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
export function linkBase(req: Request): string {
  const configured = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (configured) return configured;
  const host = req.headers.host ?? '';
  return HOST.test(host) ? `${isHttps(req) ? 'https' : 'http'}://${host}` : `http://localhost:${process.env.PORT || 3002}`;
}

export const fileLinkUrl = (base: string, kind: FileLinkKind, token: string): string =>
  `${base}/api/files/${kind}/${token}`;
