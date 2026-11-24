// Trying column changes on sample rows, in the app (services/sheet-test-*.ts): the test of a sheet (by the sheet's
// id or its copy's), start, add rows, apply (or what applying would do) and discard. REST v1:
// api-v1-sheet-test.ts; MCP: manage_sheet's test actions. While a test is open the sheet takes no other change
// (lib/sheet-busy.ts), so routes/sheets.ts lets these through: each checks the sheet itself.
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { runFailHttpStatus, type RunFail } from '../services/run-shared';
import { testOfSheet, testView } from '../services/sheet-test-store';
import { startSheetTest } from '../services/sheet-test-start';
import { addTestRows } from '../services/sheet-test-add';
import { applySheetTest } from '../services/sheet-test-apply';
import { discardSheetTest } from '../services/sheet-test-end';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { SHEET_TEST_MAX_ROWS } from '../lib/constants';
import { sheetRowsAt } from '../services/sheet-test-rows';

const router = express.Router();
router.use(authenticateToken);

const reply = (res: express.Response, out: { ok: unknown } | RunFail, status = 200) =>
  ('fail' in out ? res.status(runFailHttpStatus(out)).json({ error: out.message }) : res.status(status).json(out.ok));
const body = (req: AuthRequest) =>
  (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;

type Handler = (req: AuthRequest, res: express.Response) => unknown;
const guarded = (label: string, fn: Handler): Handler => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    console.error(`${label} error:`, error);
    if (!res.headersSent) res.status(500).json({ error: `Failed to ${label}` });
  }
};

router.get('/:id/test', guarded('read the test', (req, res) => {
  if (!verifySheetOwnership(req.params.id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
  const t = testOfSheet(req.params.id, req.userId!);
  return res.json({ test: t ? testView(t) : null });
}));

// Body: { row_indexes?, row_ids?, rows? }: the rows selected in the grid (by place), the rows chosen, or how many
// from the top (10 by default).
router.post('/:id/test', guarded('start the test', async (req, res) => {
  const b = body(req);
  const at = b.row_indexes;
  if (at !== undefined && (!Array.isArray(at) || !at.length || at.length > SHEET_TEST_MAX_ROWS
    || at.some(i => !Number.isInteger(i) || (i as number) < 0))) {
    return res.status(400).json({ error: `Select 1 to ${SHEET_TEST_MAX_ROWS} rows to test on.` });
  }
  const rowIds = at !== undefined ? sheetRowsAt(req.params.id, req.userId!, at as number[]) : b.row_ids;
  const out = await startSheetTest(req.userId!, req.params.id, { rowIds, rows: b.rows });
  return reply(res, 'ok' in out ? { ok: { test: out.ok } } : out, 201);
}));

// Body: { how?: 'top' | 'random', rows?, row_ids? }.
router.post('/:id/test/rows', guarded('add rows to the test', (req, res) => {
  const b = body(req);
  const out = addTestRows(req.userId!, req.params.id, { how: b.how, rows: b.rows, rowIds: b.row_ids });
  if ('fail' in out) return reply(res, out);
  const { added, ...test } = out.ok;
  return res.json({ test, added });
}));

// Body: { dry_run? } (the app asks what applying would do first).
router.post('/:id/test/apply', guarded('apply the test', async (req, res) =>
  reply(res, await applySheetTest(req.userId!, req.params.id,
    { dryRun: body(req).dry_run === true, hasSecretsScope: true }))));

router.post('/:id/test/discard', guarded('discard the test', (req, res) => {
  const out = discardSheetTest(req.userId!, req.params.id);
  return reply(res, 'ok' in out ? { ok: { test: out.ok } } : out);
}));

export default router;
