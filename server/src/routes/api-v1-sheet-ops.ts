// /v1 sheet operations: physical sort, removing duplicates, CSV export and
// stopping every run. Each delegates to the implementation shared with the UI
// routes (services/sheet-sort.ts, services/dedupe-*.ts, lib/csv-export.ts,
// services/sheet-runs-stop.ts).
import express from 'express';
import type { NextFunction, Response } from 'express';
import { db } from '../lib/db';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { physicalSortSheet } from '../services/sheet-sort';
import { agentRemoveDuplicates, dedupeDryRun } from '../services/dedupe-agent';
import { runFailHttpStatus } from '../services/run-shared';
import { streamSheetCsv } from '../lib/csv-export';
import { stopSheetRuns } from '../services/sheet-runs-stop';

const router = express.Router();

function ownsSheet(sheetId: string, userId: string): boolean {
  return !!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL').get(sheetId, userId);
}

// POST /v1/sheets/:id/sort {column, direction} — one-time PHYSICAL reorder
// (Google Sheets semantics; there is no live sort view).
// Bumps row_generation (inside the service txn) AND data_version (v1 rule:
// open tabs must learn their row indices are stale).
router.post('/sheets/:id/sort', requireScope('write'), async (req: TokenAuthRequest, res) => {
  try {
    if (!ownsSheet(req.params.id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    const { column, direction } = req.body as { column?: unknown; direction?: unknown };
    if (typeof column !== 'string' || !column) {
      return res.status(400).json({ error: 'column is required (string)' });
    }
    if (direction !== 'asc' && direction !== 'desc') {
      return res.status(400).json({ error: "direction must be 'asc' or 'desc'" });
    }

    const result = await physicalSortSheet(req.params.id, req.userId!, column, direction, { bumpDataVersion: true });
    if ('fail' in result) {
      if (result.fail === 'busy') return res.status(409).json({ error: result.error });
      if (result.fail === 'column_not_found') {
        return res.status(404).json({ error: `Column "${column}" not found in this sheet` });
      }
      return res.status(409).json({ error: result.message });
    }
    res.json({ rows_reordered: result.rowsReordered });
  } catch (error) {
    console.error('POST /v1/sheets/:id/sort error:', error);
    res.status(500).json({ error: 'Failed to sort sheet' });
  }
});

// POST /v1/sheets/:id/remove-duplicates {columns, keep?, dry_run?}: the same
// answer as the MCP tool remove_duplicates. A dry run (the default) only
// reads; removing (dry_run: false) needs the write scope.
const dedupeScope = (req: TokenAuthRequest, res: Response, next: NextFunction) =>
  requireScope(dedupeDryRun((req.body ?? {}).dry_run) === false ? 'write' : 'read')(req, res, next);

router.post('/sheets/:id/remove-duplicates', dedupeScope, async (req: TokenAuthRequest, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Send a JSON object.' });
    }
    const out = await agentRemoveDuplicates(req.userId!, req.params.id, body, 'rest');
    if ('fail' in out) {
      return res.status(runFailHttpStatus(out)).json({ error: out.message, ...(out.busy ? { busy: true } : {}) });
    }
    res.json(out.ok);
  } catch (error) {
    console.error('POST /v1/sheets/:id/remove-duplicates error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to remove duplicates' });
  }
});

// POST /v1/sheets/:id/runs/stop: every AI, HTTP API and enrichment run on the
// sheet and every setup being used on it, stopped at once. Same answer as MCP
// control_run's cancel_all: what it stopped and the auto-runs still on.
router.post('/sheets/:id/runs/stop', requireScope('run'), async (req: TokenAuthRequest, res) => {
  try {
    const out = await stopSheetRuns(req.userId!, req.params.id);
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('POST /v1/sheets/:id/runs/stop error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to stop the runs' });
  }
});

// GET /v1/sheets/:id/export — text/csv download (formula-injection-escaped).
// An empty sheet exports as an empty 200 body rather than the UI's 400 — an
// agent script treats "nothing there yet" as data, not an error. ?view=<name or
// id> exports that saved view: its rows and its visible columns.
router.get('/sheets/:id/export', requireScope('read'), async (req: TokenAuthRequest, res) => {
  try {
    const view = typeof req.query.view === 'string' && req.query.view.trim() ? req.query.view : undefined;
    const result = await streamSheetCsv(req.params.id, req.userId!, res, { view });
    if (result === 'not_found') return res.status(404).json({ error: 'Sheet not found' });
    if (result === 'empty') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.send('');
    }
    if (typeof result === 'object' && 'invalid' in result) return res.status(400).json({ error: result.invalid });
    if (typeof result === 'object') return res.status(409).json({ error: result.busy, busy: true });
  } catch (error) {
    console.error('GET /v1/sheets/:id/export error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to export CSV' });
    else res.destroy();
  }
});

export default router;
