// /mcp: Cubex's MCP server over Streamable HTTP (docs/mcp.md). It speaks
// 2026-07-28 to clients that send its per-request _meta, and the 2025 revisions
// to clients that open with initialize (mcp/http-entry.ts picks the era).
// STATELESS: every POST is independently authenticated by the PAT Bearer header
// (same middleware as /api/v1), a fresh McpServer is built per request (tool
// handlers close over the caller's identity), and there is no Mcp-Session-Id
// lifecycle, so GET (a stream) and DELETE (session teardown) are 405s.
// Answers are plain JSON, which passes through reverse proxies without
// buffering concerns.
//
// Order is load-bearing (same as /api/v1): the global 32MB parsers SKIP /mcp
// (applyServerMiddleware) → Origin guard (spec-mandated DNS-rebinding defense,
// pre-body) → Bearer auth → per-token limiter → tight JSON parser → transport.
import express from 'express';
import { isJsonContentType, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { authenticateAccessToken, TokenAuthRequest } from '../middleware/access-token-auth';
import { apiV1Limiter } from '../lib/limits';
import { API_V1_MAX_JSON_BYTES, MCP_FORBIDDEN_ORIGIN_CODE } from '../lib/api-v1-constants';
import { authInfoFor, serveMcp } from '../mcp/http-entry';
import {
  errorBody, FORBIDDEN_ORIGIN, INTERNAL_ERROR, METHOD_NOT_ALLOWED, NOT_JSON, NOT_UTF8_JSON, PARSE_ERROR, requestIdOf,
  TOO_LARGE,
} from '../mcp/http-answers';
import type { McpAuthCtx } from '../mcp/tool-helpers';
import { linkBase } from '../lib/file-links';
import { runAs } from '../lib/actor';
import { readTokenSpend } from '../services/token-spend';
import { redactError } from '../lib/redact';

const router = express.Router();

// MCP spec: servers MUST validate Origin (DNS-rebinding defense). Non-browser
// MCP clients (Claude Code/Desktop, Cursor, SDKs) send no Origin header → allowed.
// Cubex's own UI never calls /mcp, so a browser-originated request is allowed only
// from PUBLIC_URL's origin when that is set. A DNS-rebound page's Origin is the
// attacker's hostname and gets a hard 403 before auth or body parsing.
router.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();
  // Normalize both sides to URL.origin (scheme://host:port) so a harmless
  // trailing slash / path in PUBLIC_URL can't break legitimate clients.
  try {
    const publicUrl = process.env.PUBLIC_URL;
    if (publicUrl && new URL(origin).origin === new URL(publicUrl).origin) return next();
  } catch { /* unparseable Origin → reject below */ }
  // A JSON-RPC error with no id, as the transport page allows for this 403. The
  // spec names no code for it: MCP_FORBIDDEN_ORIGIN_CODE (api-v1-constants.ts).
  return res.status(403).json({
    jsonrpc: '2.0', error: { code: MCP_FORBIDDEN_ORIGIN_CODE, message: FORBIDDEN_ORIGIN },
  });
});

router.use(authenticateAccessToken);
router.use(apiV1Limiter); // per-token, keyed AFTER validation; before body parse
router.use(express.json({ limit: API_V1_MAX_JSON_BYTES }));
// express.json failures (malformed JSON, oversized body) must answer in
// JSON-RPC shape, not bubble to the global 500 handler. No id: the body was
// never read, so there is no request to name (the schema allows none, never null).
// A charset that isn't a UTF one, or a Content-Encoding the parser can't undo, is a
// media type it won't read (its own 415), not bad JSON: the JSON may be valid.
const UNREADABLE_BODY = new Set(['charset.unsupported', 'encoding.unsupported']);
router.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!err) return next();
  if (UNREADABLE_BODY.has(err.type)) {
    // RFC 9110 15.5.16: a 415 over the content coding names the codings accepted.
    if (err.type === 'encoding.unsupported') res.set('Accept-Encoding', 'gzip, deflate');
    return res.status(415).json(errorBody(ProtocolErrorCode.InvalidRequest, NOT_UTF8_JSON));
  }
  const status = err.type === 'entity.too.large' ? 413 : 400;
  return res.status(status).json(errorBody(ProtocolErrorCode.ParseError, status === 413 ? TOO_LARGE : PARSE_ERROR));
});

// A POST that isn't JSON: express.json left it unread, so it is refused here
// rather than read raw further on. 415, as the transport answers it, with the
// spec's code for a message that isn't a valid request (-32600).
router.post('/', async (req: TokenAuthRequest & { auth?: AuthInfo }, res) => {
  if (!isJsonContentType(req.headers['content-type'])) {
    return res.status(415).json(errorBody(ProtocolErrorCode.InvalidRequest, NOT_JSON));
  }
  const abortController = new AbortController();
  res.on('close', () => abortController.abort());
  try {
    const ctx: McpAuthCtx = {
      userId: req.userId!,
      tokenId: req.accessTokenId!,
      scopes: req.tokenScopes!,
      tokenName: req.accessTokenName ?? '',
      abortSignal: abortController.signal,
      linkBase: linkBase(req),
      spend: readTokenSpend(req.userId!, req.accessTokenId!)?.view ?? null,
    };
    req.auth = authInfoFor(ctx);
    // What the tools change is done by this token over MCP (lib/actor.ts).
    await runAs({ via: 'mcp', tokenName: req.accessTokenName ?? null, tokenId: req.accessTokenId ?? null },
      () => serveMcp(req, res, req.body));
  } catch (error) {
    // Redacted like every other MCP log line: an error here can quote the request.
    console.error('MCP request error:', redactError(error));
    if (!res.headersSent) {
      res.status(500).json(errorBody(ProtocolErrorCode.InternalError, INTERNAL_ERROR, requestIdOf(req.body)));
    }
  }
});

// No server-push stream to GET (2026-07-28 has none either) and no session to DELETE.
// A GET or DELETE carries no JSON-RPC request object at all: Invalid Request
// (-32600), the spec's code for that. No id, since there is no request to name.
// A 405 names the methods the resource takes (RFC 9110, Allow): POST only.
const methodNotAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).set('Allow', 'POST').json(errorBody(ProtocolErrorCode.InvalidRequest, METHOD_NOT_ALLOWED));
router.get('/', methodNotAllowed);
router.delete('/', methodNotAllowed);

export default router;
