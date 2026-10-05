// /v1 run reads (design-doc Phase 2): status summaries, keyset-paged per-row
// results, and the OpenRouter model-list passthrough. No SSE on v1 — clients
// and agents poll GET status.
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import {
  getAiRunSummary, getHttpRunSummary, getAiRunResults, getHttpRunResults,
  RunResultStatusFilter,
} from '../services/run-status';
import { fetchModels } from '../lib/openrouter';
import { API_V1_DEFAULT_ROWS_PAGE, API_V1_MAX_ROWS_PAGE } from '../lib/api-v1-constants';
import { searchModels } from '../lib/model-search';
import { getAccountDefaultModel } from '../lib/ai-model-resolve';
import { db } from '../lib/db';
import { listRuns, RUN_LIST_DEFAULT, RUN_LIST_MAX, type RunListFilter } from '../services/run-list';

const router = express.Router();

// GET /v1/models — OpenRouter model list passthrough (cached upstream in
// lib/openrouter.ts; serves a stale copy when OpenRouter is down).
// GET /v1/models?search=&limit= — trimmed catalog (lib/model-search.ts), exact
// id first, at most `limit` (default 50, max 500), plus the account default.
router.get('/models', requireScope('read'), async (req: TokenAuthRequest, res) => {
  try {
    const result = await fetchModels(Date.now());
    const models = result.ok ? result.models : result.stale;
    if (models) {
      const rawLimit = parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 50;
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      return res.json({ ...searchModels(models, search, limit), account_default_model: getAccountDefaultModel(req.userId!) });
    }
    res.status(502).json({ error: 'Failed to fetch models from OpenRouter' });
  } catch (error) {
    console.error('GET /v1/models error:', error);
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

// GET /v1/runs?sheet_id=&filter=active|terminal|all&limit= — recent AI and
// HTTP runs, newest first (services/run-list.ts, shared with MCP list_runs),
// so a script that lost a run_id can find it again.
router.get('/runs', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    const sheetId = typeof req.query.sheet_id === 'string' && req.query.sheet_id ? req.query.sheet_id : undefined;
    if (sheetId && !db.prepare('SELECT 1 FROM sheets WHERE id = ? AND user_id = ?').get(sheetId, req.userId!)) {
      return res.status(404).json({ error: 'Sheet not found' });
    }
    const filter = req.query.filter ?? 'all';
    if (filter !== 'active' && filter !== 'terminal' && filter !== 'all') {
      return res.status(400).json({ error: 'filter must be active, terminal or all' });
    }
    const rawLimit = req.query.limit === undefined ? RUN_LIST_DEFAULT : Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > RUN_LIST_MAX) {
      return res.status(400).json({ error: `limit must be a whole number from 1 to ${RUN_LIST_MAX}` });
    }
    const runs = listRuns(req.userId!, { sheetId, filter: filter as RunListFilter, limit: rawLimit });
    res.json({ runs, count: runs.length });
  } catch (error) {
    console.error('GET /v1/runs error:', error);
    res.status(500).json({ error: 'Failed to list runs' });
  }
});

function pageParams(req: express.Request): { after: number; limit: number } {
  const rawLimit = parseInt(String(req.query.limit ?? ''), 10);
  const limit = Number.isInteger(rawLimit)
    ? Math.max(1, Math.min(rawLimit, API_V1_MAX_ROWS_PAGE))
    : API_V1_DEFAULT_ROWS_PAGE;
  const rawCursor = parseInt(String(req.query.cursor ?? ''), 10);
  const after = Number.isInteger(rawCursor) && rawCursor >= 0 ? rawCursor : -1;
  return { after, limit };
}

// GET /v1/{ai,http}-runs/:id — lean status: state, progress, error_message.
router.get('/ai-runs/:id', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    const run = getAiRunSummary(req.params.id, req.userId!);
    if (!run) return res.status(404).json({ error: 'AI run not found' });
    res.json(run);
  } catch (error) {
    console.error('GET /v1/ai-runs/:id error:', error);
    res.status(500).json({ error: 'Failed to fetch AI run' });
  }
});

router.get('/http-runs/:id', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    const run = getHttpRunSummary(req.params.id, req.userId!);
    if (!run) return res.status(404).json({ error: 'HTTP run not found' });
    res.json(run);
  } catch (error) {
    console.error('GET /v1/http-runs/:id error:', error);
    res.status(500).json({ error: 'Failed to fetch HTTP run' });
  }
});

// ?status=failed|completed|all — filters IN SQL so a page of failures is a page
// of failures (post-filtering would return an empty array with a live cursor).
// Defaults to 'all': this is a versioned contract and existing clients expect
// every row. The MCP tool defaults to 'failed' instead — it's agent-facing and
// optimizes for the diagnostic case. Unknown value = 400, not a silent 'all'.
function statusFilterParam(req: express.Request): RunResultStatusFilter | { error: string } {
  const raw = req.query.status;
  if (raw === undefined) return 'all';
  if (raw === 'failed' || raw === 'completed' || raw === 'all') return raw;
  return { error: "status must be one of: failed, completed, all" };
}

// GET /v1/{ai,http}-runs/:id/results?limit&cursor&status — per-row detail,
// keyset-paged by row_index, each row carrying its STABLE row id (null if deleted).
router.get('/ai-runs/:id/results', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    const { after, limit } = pageParams(req);
    const filter = statusFilterParam(req);
    if (typeof filter !== 'string') return res.status(400).json({ error: filter.error });
    const page = getAiRunResults(req.params.id, req.userId!, after, limit, filter);
    if (!page) return res.status(404).json({ error: 'AI run not found' });
    res.json(page);
  } catch (error) {
    console.error('GET /v1/ai-runs/:id/results error:', error);
    res.status(500).json({ error: 'Failed to fetch AI run results' });
  }
});

router.get('/http-runs/:id/results', requireScope('read'), (req: TokenAuthRequest, res) => {
  try {
    const { after, limit } = pageParams(req);
    const filter = statusFilterParam(req);
    if (typeof filter !== 'string') return res.status(400).json({ error: filter.error });
    const page = getHttpRunResults(req.params.id, req.userId!, after, limit, filter);
    if (!page) return res.status(404).json({ error: 'HTTP run not found' });
    res.json(page);
  } catch (error) {
    console.error('GET /v1/http-runs/:id/results error:', error);
    res.status(500).json({ error: 'Failed to fetch HTTP run results' });
  }
});

export default router;
