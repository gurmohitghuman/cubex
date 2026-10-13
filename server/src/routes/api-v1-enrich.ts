// /v1 enrichments (treg.to): the catalog, run starts, a column from stored
// answers, a list job's fields and auto-run. Thin wrappers over the services
// the MCP tools use (services/enrich-agent-*.ts, enrich-token-run.ts), so the
// two surfaces can't drift. A started run answers 202 like the AI and HTTP
// run starts; an estimate or a replayed start answers 200.
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { TREG_TOOL_ID_PATTERN } from '../lib/constants';
import { setRateLimitedHeaders } from '../lib/rate-window';
import { runFailHttpStatus, type RunFail } from '../services/run-shared';
import type { CatalogFailure } from '../services/enrich-catalog';
import { agentGetTool, agentSearchTools } from '../services/enrich-agent-tools';
import { tokenStartEnrichmentRun } from '../services/enrich-token-run';
import { agentAddField, agentAddListRows, agentListFields } from '../services/enrich-agent-fields';
import { agentSetAutorun } from '../services/enrich-agent-autorun';
import { readBalances } from '../services/balances';

const router = express.Router();

const catalogFail = (res: express.Response, f: CatalogFailure) =>
  res.status(f.fail === 'not_found' ? 404 : f.fail === 'hidden' ? 422 : 502).json({ error: f.message });
const fail = (res: express.Response, f: RunFail) => res.status(runFailHttpStatus(f)).json({ error: f.message });
const body = (req: express.Request) => (req.body ?? {}) as Record<string, unknown>;

// Wraps a handler with the usual 500 for an unexpected throw.
function handle(what: string, fn: (req: TokenAuthRequest, res: express.Response) => Promise<unknown> | unknown) {
  return async (req: TokenAuthRequest, res: express.Response) => {
    try {
      await fn(req, res);
    } catch (error) {
      console.error(`${req.method} /v1${req.path} error:`, error);
      if (!res.headersSent) res.status(500).json({ error: `Failed to ${what}` });
    }
  };
}

// GET /v1/balances: the treg balance, the enrichment daily limit and what
// OpenRouter reports for the saved key (get_balances).
router.get('/balances', requireScope('read'), handle('read the balances', async (req, res) => {
  res.json(await readBalances(req.userId!));
}));

// GET /v1/enrichments?q= : treg's catalog (no q: the popular jobs).
router.get('/enrichments', requireScope('read'), handle('search enrichments', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  const out = await agentSearchTools(q);
  return 'ok' in out ? res.json(out.ok) : catalogFail(res, out);
}));

router.get('/enrichments/:toolId', requireScope('read'), handle('read the enrichment', async (req, res) => {
  if (!TREG_TOOL_ID_PATTERN.test(req.params.toolId)) return res.status(400).json({ error: 'Invalid tool id' });
  const out = await agentGetTool(req.userId!, req.params.toolId);
  return 'ok' in out ? res.json(out.ok) : catalogFail(res, out);
}));

// POST /v1/sheets/:id/enrichment-runs: run_enrichment's arguments as JSON
// (idempotency_key in the body or the Idempotency-Key header).
router.post('/sheets/:id/enrichment-runs', requireScope('run'), handle('start the enrichment', async (req, res) => {
  const b = body(req);
  const r = await tokenStartEnrichmentRun(
    { userId: req.userId!, tokenId: req.accessTokenId!, scopes: req.tokenScopes ?? new Set() },
    { ...b, sheet_id: req.params.id, idempotency_key: b.idempotency_key ?? req.get('Idempotency-Key') ?? undefined },
  );
  if ('fail' in r) {
    if (r.fail === 'rate_limited') {
      if (r.rate) setRateLimitedHeaders(res, r.rate);
      return res.status(429).json({ error: r.message, retry_after_seconds: r.rate?.retryAfterSec });
    }
    return fail(res, { fail: r.fail, message: r.message });
  }
  return res.status(r.started ? 202 : 200).json(r.ok);
}));

// POST /v1/sheets/:id/enrichment-fields {column, json_path, column_name, row_id?}
router.post('/sheets/:id/enrichment-fields', requireScope('write'), handle('add the column', async (req, res) => {
  const out = await agentAddField(req.userId!, req.params.id, body(req));
  return 'ok' in out ? res.status(202).json(out.ok) : fail(res, out);
}));

// GET /v1/sheets/:id/enrichment-list-fields?column= : the fields a list job's results have.
router.get('/sheets/:id/enrichment-list-fields', requireScope('read'), handle('read the fields', (req, res) => {
  const out = agentListFields(req.userId!, req.params.id, req.query.column);
  return 'ok' in out ? res.json(out.ok) : fail(res, out);
}));

// POST /v1/sheets/:id/enrichment-list-fields {column, fields: [{path, column_name}], dedupe_path?}
router.post('/sheets/:id/enrichment-list-fields', requireScope('write'), handle('add the rows', async (req, res) => {
  const out = await agentAddListRows(req.userId!, req.params.id, body(req));
  return 'ok' in out ? res.json(out.ok) : fail(res, out);
}));

// PUT /v1/sheets/:id/enrichment-auto-run {column?, enabled? | paused?, where?, daily_cap_usd?, daily_row_cap?}
router.put('/sheets/:id/enrichment-auto-run', requireScope('run'), handle('save auto-run', async (req, res) => {
  const out = await agentSetAutorun(req.userId!, req.params.id, body(req), req.tokenScopes?.has('secrets') === true);
  return 'ok' in out ? res.json(out.ok) : fail(res, out);
}));

export default router;
