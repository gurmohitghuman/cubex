// /api/v1 setup calls: a saved setup run on items without a sheet, and its results. Thin wrappers over
// services/setup-call.ts, which MCP's call_setup and get_setup_call use too, so the surfaces can't drift. Pause,
// resume and stop: POST /v1/setup-runs/:id/control with the call's id (api-v1-setups.ts).
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { runFailHttpStatus } from '../services/run-shared';
import { setRateLimitedHeaders } from '../lib/rate-window';
import fs from 'fs';
import { CALL_NOT_FOUND, callSetup, getSetupCall } from '../services/setup-call';
import { callInputOf } from '../services/setup-call-input';
import { dropFileCall, prepareFileCall, startFileCall } from '../services/setup-call-file';
import { scanCsvFile, CsvHeaderCollisionError } from '../lib/csv-import-parse';
import { importCsv } from '../services/csv-import';
import { MAX_CSV_UPLOAD_BYTES } from '../lib/constants';
import { csvUploadMiddleware } from './sheets-shared';

const router = express.Router();

const body = (req: TokenAuthRequest) =>
  (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;

type Handler = (req: TokenAuthRequest, res: express.Response) => unknown;
const guarded = (route: string, fn: Handler): Handler => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    console.error(`${route} error:`, error);
    if (!res.headersSent) res.status(500).json({ error: 'Setup call failed' });
  }
};

// { items, models, estimate_only, webhook_id, max_cost_usd, allow_unpriced }: a price (200), or the call (201).
router.post('/setups/:setupId/calls', requireScope('run'), guarded('POST /v1/setups/:id/calls', async (req, res) => {
  const b = body(req);
  const input = callInputOf(b, 'v1');
  if ('fail' in input) return res.status(runFailHttpStatus(input)).json({ error: input.message });
  const out = await callSetup(req.userId!, req.params.setupId, b.items, input,
    { hasSecretsScope: !!req.tokenScopes?.has('secrets'), tokenId: req.accessTokenId });
  if ('fail' in out) {
    const kind = out.fail;
    if (kind === 'rate_limited') {
      if (out.rate) setRateLimitedHeaders(res, out.rate);
      return res.status(429).json({ error: out.message, retry_after_seconds: out.rate?.retryAfterSec });
    }
    // Over the ceiling: 409 with the estimate it was checked against (over_ceiling: true).
    const over = kind === 'over_ceiling' ? { over_ceiling: true, estimate: out.estimate } : {};
    return res.status(runFailHttpStatus({ fail: kind, message: out.message })).json({ error: out.message, ...over });
  }
  return res.status('setup_call' in out.ok ? 201 : 200).json(out.ok);
}));

// Multipart: the CSV in `file`, its header naming the setup's inputs, and max_cost_usd (required: nobody sees an
// estimate first), allow_unpriced, webhook_id as form fields. The call starts once the rows are in (201).
router.post('/setups/:setupId/calls/file', requireScope('run'), csvUploadMiddleware,
  guarded('POST /v1/setups/:id/calls/file', async (req, res) => {
    const remove = () => { if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); };
    try {
      if (!req.file) return res.status(400).json({ error: 'CSV file is required (multipart field "file")' });
      if (req.file.size > MAX_CSV_UPLOAD_BYTES) {
        const mb = Math.round(MAX_CSV_UPLOAD_BYTES / 1048576);
        return res.status(400).json({ error: `File size exceeds ${mb}MB limit` });
      }
      const form = body(req);
      const max = typeof form.max_cost_usd === 'string' && form.max_cost_usd.trim() !== ''
        ? Number(form.max_cost_usd) : form.max_cost_usd;
      const input = callInputOf({ max_cost_usd: max, allow_unpriced: form.allow_unpriced === 'true' || undefined,
        webhook_id: form.webhook_id || undefined, estimate_only: false }, 'v1');
      if ('fail' in input) return res.status(runFailHttpStatus(input)).json({ error: input.message });
      let scanned;
      try {
        scanned = await scanCsvFile(req.file.path);
      } catch (parseErr) {
        return res.status(400).json({ error: parseErr instanceof CsvHeaderCollisionError ? parseErr.message
          : 'CSV could not be parsed. Check the file is valid UTF-8 CSV.' });
      }
      const prepared = prepareFileCall(req.userId!, req.params.setupId, input,
        { hasSecretsScope: !!req.tokenScopes?.has('secrets') });
      if ('fail' in prepared) return res.status(runFailHttpStatus(prepared)).json({ error: prepared.message });
      const imported = await importCsv(prepared.sheetId, req.userId!, scanned, false,
        { bumpDataVersion: true, seedEmptyRow: false });
      if ('fail' in imported) {
        dropFileCall(req.userId!, prepared.call);
        const error = 'error' in imported ? imported.error : 'The file could not be imported.';
        return res.status(400).json({ error });
      }
      const out = await startFileCall(req.userId!, prepared.sheetId, prepared.call);
      if ('fail' in out) {
        const over = out.fail === 'over_ceiling' ? { over_ceiling: true, estimate: out.estimate } : {};
        return res.status(runFailHttpStatus(out)).json({ error: out.message, ...over });
      }
      return res.status(201).json(out.ok);
    } finally { remove(); }
  }));

// ?results_from=&limit=: a page of a finished call's items (next_from says where the next starts).
const pageArg = (v: unknown): number | undefined =>
  (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
router.get('/setup-calls/:callId', requireScope('read'), guarded('GET /v1/setup-calls/:id', (req, res) => {
  const call = getSetupCall(req.userId!, req.params.callId,
    { from: pageArg(req.query.results_from), limit: pageArg(req.query.limit) });
  return call ? res.json(call) : res.status(404).json({ error: CALL_NOT_FOUND });
}));

export default router;
