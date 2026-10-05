// /v1 run control (design-doc Phase 2): pause/resume/cancel + rerun for AI and
// HTTP runs, over the same services as the UI routes and MCP. Unlike the UI's
// idempotent 200s, v1 is strict: acting on a missing run is 404 and on a run
// in the wrong state is 409 — an agent needs the real outcome, not politeness.
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { pauseRun, resumeRun, cancelRun, ControlOutcome, RunKind } from '../services/run-lifecycle';
import { rerunAiRunById, rerunHttpRunById } from '../services/run-rerun-by-id';
import { AI_RERUN_MODES, AiRerunMode } from '../services/ai-rerun-modes';
import { getAiRunSummary, getHttpRunSummary } from '../services/run-status';
import { runStartWindow, runFailHttpStatus } from '../services/run-shared';
import { setRateLimitedHeaders, tooManyMessage } from '../lib/rate-window';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';

const router = express.Router();

// Takes a run-start slot, or answers the 429 (with Retry-After) and returns true.
function refuseRunStart(req: TokenAuthRequest, res: express.Response): boolean {
  const slot = runStartWindow(req.accessTokenId!);
  if (slot.allowed) return false;
  setRateLimitedHeaders(res, slot);
  res.status(429).json({ error: tooManyMessage('run starts', slot), retry_after_seconds: slot.retryAfterSec });
  return true;
}

const controlStatus = (f: Exclude<ControlOutcome, { ok: true }>): number =>
  f.fail === 'not_found' ? 404
  : f.fail === 'secrets_required' ? 403
  : 409;

// Registers pause/resume/cancel for one run kind; responses echo the fresh
// run summary so the agent sees the post-action state without a second GET.
function registerControls(prefix: string, kind: RunKind) {
  const summary = kind === 'ai' ? getAiRunSummary : getHttpRunSummary;

  router.post(`/${prefix}/:id/pause`, requireScope('run'), (req: TokenAuthRequest, res) => {
    try {
      const result = pauseRun(kind, req.params.id, req.userId!);
      if ('fail' in result) return res.status(controlStatus(result)).json({ error: result.message });
      res.json(summary(req.params.id, req.userId!));
    } catch (error) {
      console.error(`POST /v1/${prefix}/:id/pause error:`, error);
      res.status(500).json({ error: 'Failed to pause run' });
    }
  });

  router.post(`/${prefix}/:id/resume`, requireScope('run'), async (req: TokenAuthRequest, res) => {
    try {
      const result = await resumeRun(kind, req.params.id, req.userId!, req.tokenScopes?.has('secrets') === true);
      if ('fail' in result) return res.status(controlStatus(result)).json({ error: result.message });
      res.json(summary(req.params.id, req.userId!));
    } catch (error) {
      console.error(`POST /v1/${prefix}/:id/resume error:`, error);
      res.status(500).json({ error: 'Failed to resume run' });
    }
  });

  router.post(`/${prefix}/:id/cancel`, requireScope('run'), async (req: TokenAuthRequest, res) => {
    try {
      const result = await cancelRun(kind, req.params.id, req.userId!);
      if ('fail' in result) return res.status(controlStatus(result)).json({ error: result.message });
      res.json(summary(req.params.id, req.userId!));
    } catch (error) {
      console.error(`POST /v1/${prefix}/:id/cancel error:`, error);
      res.status(500).json({ error: 'Failed to cancel run' });
    }
  });
}

registerControls('ai-runs', 'ai');
registerControls('http-runs', 'http');

// row_ids (optional): validated but NOT resolved here — the rerun-by-id
// services resolve against the run's own sheet.
function parseRowIds(raw: unknown): { rowIds?: string[] } | { error: string } {
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw) || raw.length === 0 || raw.some(x => typeof x !== 'string')) {
    return { error: 'row_ids must be a non-empty array of row id strings' };
  }
  if (raw.length > MAX_ROWS_PER_SHEET) {
    return { error: `row_ids is capped at ${MAX_ROWS_PER_SHEET} entries.` };
  }
  return { rowIds: raw as string[] };
}

// POST /v1/ai-runs/:id/rerun — body { row_ids?, mode? }. row_ids wins; mode is
// one of errored|empty|missing|all and REQUIRED without row_ids, as on MCP: a
// default of 'missing' re-billed every empty row of the column (MCP dropped it
// after a 10-row retry became a 9,675-row run). 409 when :id has been
// superseded by a newer run on the same column (the message names the latest).
router.post('/ai-runs/:id/rerun', requireScope('run'), async (req: TokenAuthRequest, res) => {
  try {
    const body = (req.body ?? {}) as { row_ids?: unknown; mode?: unknown };
    const p = parseRowIds(body.row_ids);
    if ('error' in p) return res.status(400).json({ error: p.error });
    if (p.rowIds === undefined && body.mode === undefined) {
      return res.status(400).json({
        error: `Pass row_ids, or mode (${AI_RERUN_MODES.join(', ')}): "errored" re-runs only the failed rows; "all" re-bills every row.`,
      });
    }
    if (body.mode !== undefined && !AI_RERUN_MODES.includes(body.mode as AiRerunMode)) {
      return res.status(400).json({ error: `mode must be one of: ${AI_RERUN_MODES.join(', ')}` });
    }
    // A rerun is a run start: same per-token window as MCP's control_run.
    if (refuseRunStart(req, res)) return;
    const result = await rerunAiRunById(req.userId!, req.params.id, {
      rowIds: p.rowIds, mode: body.mode as AiRerunMode | undefined,
    });
    if ('fail' in result) return res.status(runFailHttpStatus(result)).json({ error: result.message });
    res.status(202).json({ run_id: result.ok.runId, target_rows: result.ok.targetCount });
  } catch (error) {
    console.error('POST /v1/ai-runs/:id/rerun error:', error);
    res.status(500).json({ error: 'Failed to start AI re-run' });
  }
});

// POST /v1/http-runs/:id/rerun — body { row_ids?, mode? ('missing' | 'all') }.
// row_ids wins; mode 'missing' = rows whose status cell is empty/failed/
// processing; default = every row. No secrets re-check: a rerun reuses the
// stored config unmodified (it cannot repoint a key), and the run-level
// allow_secrets policy is copied from the run it clones.
router.post('/http-runs/:id/rerun', requireScope('run'), async (req: TokenAuthRequest, res) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const p = parseRowIds(b.row_ids);
    if ('error' in p) return res.status(400).json({ error: p.error });
    if (b.mode !== undefined && b.mode !== 'missing' && b.mode !== 'all') {
      return res.status(400).json({ error: "mode must be 'missing' or 'all'" });
    }
    if (refuseRunStart(req, res)) return;
    const result = await rerunHttpRunById(req.userId!, req.params.id, {
      rowIds: p.rowIds, mode: b.mode as 'missing' | 'all' | undefined,
      hasSecretsScope: req.tokenScopes?.has('secrets') === true,
    });
    if ('fail' in result) return res.status(runFailHttpStatus(result)).json({ error: result.message });
    res.status(202).json({ run_id: result.ok.runId, target_rows: result.ok.targetCount });
  } catch (error) {
    console.error('POST /v1/http-runs/:id/rerun error:', error);
    res.status(500).json({ error: 'Failed to start HTTP re-run' });
  }
});

export default router;
