// /mcp — Cubex's MCP server over Streamable HTTP (docs/mcp.md).
// STATELESS transport: every POST is independently authenticated by the PAT
// Bearer header (same middleware as /api/v1), a fresh McpServer + transport
// pair is built per request (tool handlers close over the caller's identity),
// and there is no Mcp-Session-Id lifecycle — so GET (SSE stream) and DELETE
// (session teardown) are 405s. enableJsonResponse makes tool responses plain
// JSON rather than SSE, which passes through reverse proxies without buffering concerns.
//
// Order is load-bearing (same as /api/v1): the global 32MB parsers SKIP /mcp
// (applyServerMiddleware) → Origin guard (spec-mandated DNS-rebinding defense,
// pre-body) → Bearer auth → per-token limiter → tight JSON parser → transport.
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authenticateAccessToken, TokenAuthRequest } from '../middleware/access-token-auth';
import { apiV1Limiter } from '../lib/limits';
import { API_V1_MAX_JSON_BYTES } from '../lib/api-v1-constants';
import { buildMcpServer } from '../mcp/build-server';

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
  return res.status(403).json({
    jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden origin' }, id: null,
  });
});

router.use(authenticateAccessToken);
router.use(apiV1Limiter); // per-token, keyed AFTER validation; before body parse
router.use(express.json({ limit: API_V1_MAX_JSON_BYTES }));
// express.json failures (malformed JSON, oversized body) must answer in
// JSON-RPC shape, not bubble to the global 500 handler.
router.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!err) return next();
  const status = err.type === 'entity.too.large' ? 413 : 400;
  return res.status(status).json({
    jsonrpc: '2.0',
    error: { code: -32700, message: status === 413 ? 'Request body too large' : 'Parse error' },
    id: null,
  });
});

router.post('/', async (req: TokenAuthRequest, res) => {
  const abortController = new AbortController();
  res.on('close', () => abortController.abort());
  try {
    const server = buildMcpServer({
      userId: req.userId!,
      tokenId: req.accessTokenId!,
      scopes: req.tokenScopes!,
      tokenName: req.accessTokenName ?? '',
      abortSignal: abortController.signal,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — the Bearer token is the identity
      enableJsonResponse: true,
    });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request error:', error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

// Stateless mode has no server-push stream to GET and no session to DELETE.
const methodNotAllowed = (_req: express.Request, res: express.Response) =>
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
router.get('/', methodNotAllowed);
router.delete('/', methodNotAllowed);

export default router;
