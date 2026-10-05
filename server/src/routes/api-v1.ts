// /api/v1 — the token-authenticated programmatic surface (docs/mcp.md).
// Order is load-bearing: the global 32MB parsers SKIP this prefix
// (applyServerMiddleware), so Bearer auth runs before any body is read, then a
// route-level parser with a tight cap governs. Session cookies are never
// accepted here. Data-plane endpoints (tables/sheets/rows/columns/runs) land in
// Phase 1/2 sub-routers; /me is the auth smoke endpoint every client starts with.
import express from 'express';
import { db } from '../lib/db';
import {
  authenticateAccessToken,
  requireScope,
  TokenAuthRequest,
} from '../middleware/access-token-auth';
import { API_V1_MAX_JSON_BYTES } from '../lib/api-v1-constants';
import { apiV1Limiter } from '../lib/limits';
import tablesV1 from './api-v1-tables';
import tableSheetsV1 from './api-v1-table-sheets';
import sheetsV1 from './api-v1-sheets';
import sheetOpsV1 from './api-v1-sheet-ops';
import rowsV1 from './api-v1-rows';
import columnsV1 from './api-v1-columns';
import importV1 from './api-v1-import';
import runsV1 from './api-v1-runs';
import runReadsV1 from './api-v1-run-reads';
import runControlV1 from './api-v1-run-control';
import transferV1 from './api-v1-transfer';
import { MCP_EFFICIENT_ROWS_ENABLED } from '../lib/api-v1-constants';
import { refuseChangesWhileBusy } from '../lib/sheet-busy';

const router = express.Router();
router.use(authenticateAccessToken);
router.use(apiV1Limiter); // per-token, keyed AFTER validation; before body parse
router.use(express.json({ limit: API_V1_MAX_JSON_BYTES }));
// Malformed JSON / oversized bodies get a clean 400/413 instead of the global
// 500 handler (an agent retries on a clear client error; a 500 looks like us).
router.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  return res.status(400).json({ error: 'Invalid JSON body' });
});

// Data plane (Phase 1): discovery, CRUD, reads, row/column mutations, sort, export.
// Same busy-sheet rule as the UI routes (lib/sheet-busy.ts).
router.use('/sheets/:id', refuseChangesWhileBusy(['/rows', '/rows/query']));
router.use(tablesV1);
router.use(tableSheetsV1);
router.use(sheetsV1);
router.use(sheetOpsV1);
router.use(rowsV1);
if (MCP_EFFICIENT_ROWS_ENABLED) router.use(transferV1);
router.use(columnsV1);
router.use(importV1);
// Enrichment (Phase 2): AI/HTTP run starts, status/results reads, control.
router.use(runsV1);
router.use(runReadsV1);
router.use(runControlV1);

// GET /api/v1/me — who am I, and what can this token do. Lets a script or MCP
// client validate its configuration before touching data.
router.get('/me', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    const user = db.prepare('SELECT id FROM users WHERE id = ?')
      .get(req.userId!) as { id: string } | undefined;
    if (!user) return res.status(401).json({ error: 'Invalid or missing access token' });
    res.json({
      user_id: user.id,
      token: { name: req.accessTokenName, scopes: [...(req.tokenScopes ?? [])] },
    });
  } catch (error) {
    console.error('GET /v1/me error:', error);
    res.status(500).json({ error: 'Failed to fetch account info' });
  }
});

export default router;
