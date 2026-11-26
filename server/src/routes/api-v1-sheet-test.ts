// /api/v1 tests of column changes on sample rows (services/sheet-test-*.ts; the app's routes/sheets-test.ts and
// MCP's manage_sheet do the same): read a sheet's test (by the sheet's id or its copy's), start one ('write'), add
// rows ('write'), apply ('write' and 'run': it sets what runs and auto-run do; 'secrets' when a request it writes
// reads saved keys; a dry run by default, which only reads) and discard ('write'). While a test is open the sheet
// takes no other change (lib/sheet-busy.ts); api-v1-shared.ts lets these through: each checks the sheet itself.
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { runFailHttpStatus, type RunFail } from '../services/run-shared';
import { testOfSheet, testView } from '../services/sheet-test-store';
import { startSheetTest } from '../services/sheet-test-start';
import { addTestRows } from '../services/sheet-test-add';
import { applySheetTest } from '../services/sheet-test-apply';
import { discardSheetTest } from '../services/sheet-test-end';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { flagOf } from '../lib/enrich-agent-input';

const router = express.Router();

const reply = (res: express.Response, out: { ok: unknown } | RunFail, status = 200) =>
  ('fail' in out ? res.status(runFailHttpStatus(out)).json({ error: out.message }) : res.status(status).json(out.ok));
const body = (req: TokenAuthRequest) =>
  (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;

type Handler = (req: TokenAuthRequest, res: express.Response) => unknown;
const guarded = (route: string, fn: Handler): Handler => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    console.error(`${route} error:`, error);
    if (!res.headersSent) res.status(500).json({ error: 'Test request failed' });
  }
};

const BASE = '/sheets/:id/test';

router.get(BASE, requireScope('read'), guarded(`GET /v1${BASE}`, (req, res) => {
  if (!verifySheetOwnership(req.params.id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
  const t = testOfSheet(req.params.id, req.userId!);
  return res.json({ test: t ? testView(t) : null });
}));

// Body: { row_ids?, rows? }.
router.post(BASE, requireScope('write'), guarded(`POST /v1${BASE}`, async (req, res) => {
  const b = body(req);
  const out = await startSheetTest(req.userId!, req.params.id, { rowIds: b.row_ids, rows: b.rows });
  return reply(res, 'ok' in out ? { ok: { test: out.ok } } : out, 201);
}));

// Body: { how?: 'top' | 'random', rows?, row_ids? }.
router.post(`${BASE}/rows`, requireScope('write'), guarded(`POST /v1${BASE}/rows`, (req, res) => {
  const b = body(req);
  const out = addTestRows(req.userId!, req.params.id, { how: b.how, rows: b.rows, rowIds: b.row_ids });
  if ('fail' in out) return reply(res, out);
  const { added, ...test } = out.ok;
  return res.json({ test, added });
}));

// Body: { dry_run? }: a dry run unless dry_run is false.
router.post(`${BASE}/apply`, requireScope('read'), guarded(`POST /v1${BASE}/apply`, async (req, res) => {
  const flag = flagOf(body(req).dry_run);
  if (flag === 'invalid') return res.status(400).json({ error: 'dry_run must be true or false.' });
  const dryRun = flag !== false;
  for (const scope of dryRun ? [] : ['write', 'run'] as const) {
    if (!req.tokenScopes?.has(scope)) {
      return res.status(403).json({ error: `This action requires the '${scope}' scope` });
    }
  }
  return reply(res, await applySheetTest(req.userId!, req.params.id,
    { dryRun, hasSecretsScope: !!req.tokenScopes?.has('secrets') }));
}));

router.post(`${BASE}/discard`, requireScope('write'), guarded(`POST /v1${BASE}/discard`, (req, res) => {
  const out = discardSheetTest(req.userId!, req.params.id);
  return reply(res, 'ok' in out ? { ok: { test: out.ok } } : out);
}));

export default router;
