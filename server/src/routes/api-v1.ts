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
import { versionInfo } from '../services/version-info';
import { changesSince } from '../services/version-changes';
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
import runUndoV1 from './api-v1-run-undo';
import transferV1 from './api-v1-transfer';
import enrichV1 from './api-v1-enrich';
import waterfallV1 from './api-v1-waterfall';
import runConditionsV1 from './api-v1-run-conditions';
import cleanV1 from './api-v1-clean';
import formulaV1 from './api-v1-formula';
import lookupV1 from './api-v1-lookup';
import setupsV1 from './api-v1-setups';
import viewsV1 from './api-v1-views';
import setupVersionsV1 from './api-v1-setup-versions';
import usageV1 from './api-v1-usage';
import trashV1 from './api-v1-trash';
import savedKeysV1 from './api-v1-saved-keys';
import aiVisibilityV1 from './api-v1-ai-visibility';
import { refuseChangesWhileBusy } from '../lib/sheet-busy';
import { V1_SHEET_BUSY_ALLOWED } from './api-v1-shared';
import { runWebhookRoutes } from './run-webhooks-routes';
import { actAs } from '../lib/actor';
import { tokenSpendFor } from '../services/token-spend';
import { openApiDocument } from '../openapi/document';

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
// What a call changes is done by its token (lib/actor.ts), set after the body
// parser, whose stream events would otherwise drop it.
router.use(actAs(req => ({
  via: 'api', tokenName: (req as TokenAuthRequest).accessTokenName ?? null,
  tokenId: (req as TokenAuthRequest).accessTokenId ?? null,
})));

// Data plane (Phase 1): discovery, CRUD, reads, row/column mutations, sort, export.
// Same busy-sheet rule as the UI routes (lib/sheet-busy.ts); what goes through: api-v1-shared.ts.
router.use('/sheets/:id', refuseChangesWhileBusy(V1_SHEET_BUSY_ALLOWED));
router.use(tablesV1);
router.use(aiVisibilityV1);
router.use(tableSheetsV1);
router.use(sheetsV1);
router.use(sheetOpsV1);
router.use(rowsV1);
router.use(transferV1);
router.use(columnsV1);
// Clean data columns: free cleaning into a new column (services/clean-agent.ts).
router.use(cleanV1);
// Formula columns: a free JavaScript formula per row into a new column (services/formula-agent.ts).
router.use(formulaV1);
// Lookup columns: a free column filled from another sheet (services/lookup-agent.ts).
router.use(lookupV1);
// Setups: a saved chain of filled columns, used again on other sheets (services/setup-*.ts).
router.use(setupsV1);
router.use(viewsV1);
// Setup versions: a sheet's column setup kept by name, compared and restored (services/setup-version-*.ts).
router.use(setupVersionsV1);
router.use(importV1);
// Enrichment (Phase 2): AI/HTTP run starts, status/results reads, control.
router.use(runsV1);
router.use(runReadsV1);
router.use(runControlV1);
router.use(runUndoV1);
router.use(runConditionsV1);
// Enrichments (treg.to): catalog, run starts, fields, auto-run.
router.use(enrichV1);
// Waterfall columns: one result per row from ordered steps (services/waterfall-*.ts).
router.use(waterfallV1);
// "Run finished" webhooks: signed notices when a run ends (services/run-hooks.ts).
router.use(runWebhookRoutes('/run-webhooks', requireScope));
router.use(usageV1);
router.use(trashV1);
// Saved API keys by name and where they're used, never a value (services/saved-key-uses.ts).
router.use(savedKeysV1);

// GET /api/v1/me — who am I, and what can this token do (its scopes, and its
// spend cap with what is left). Lets a script or MCP client validate its
// configuration before touching data.
router.get('/me', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    const user = db.prepare('SELECT id FROM users WHERE id = ?')
      .get(req.userId!) as { id: string } | undefined;
    if (!user) return res.status(401).json({ error: 'Invalid or missing access token' });
    res.json({
      user_id: user.id,
      token: {
        name: req.accessTokenName, scopes: [...(req.tokenScopes ?? [])],
        spend: tokenSpendFor(req.userId!, req.accessTokenId!),
      },
    });
  } catch (error) {
    console.error('GET /v1/me error:', error);
    res.status(500).json({ error: 'Failed to fetch account info' });
  }
});

// GET /api/v1/version: the running version, the latest release the daily check found and whether it
// is newer (services/version-info.ts; get_version and Settings read the same). Reads only what is kept:
// it never asks GitHub. ?since=<release> adds what changed for agents after it, as get_version's since.
router.get('/version', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    const info = versionInfo(req.userId!);
    if (req.query.since === undefined) return res.json(info);
    const changes = changesSince(req.query.since);
    if ('error' in changes) return res.status(400).json({ error: changes.error });
    res.json({ ...info, changes_since: changes.ok });
  } catch (error) {
    console.error('GET /v1/version error:', error);
    res.status(500).json({ error: 'Failed to read the version' });
  }
});

// GET /api/v1/openapi.json: this API described as OpenAPI 3.1 (server/src/openapi/),
// for Postman, Swagger UI or a client generator. Any valid token may read it.
router.get('/openapi.json', requireScope('read'), (_req, res) => {
  try {
    res.json(openApiDocument());
  } catch (error) {
    console.error('GET /v1/openapi.json error:', error);
    res.status(500).json({ error: 'Failed to build the OpenAPI document' });
  }
});

export default router;
