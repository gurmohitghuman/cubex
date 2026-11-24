// /api/v1 setup calls: a saved setup run on items without a sheet, and its results. Thin wrappers over
// services/setup-call.ts, which MCP's call_setup and get_setup_call use too, so the surfaces can't drift. Pause,
// resume and stop: POST /v1/setup-runs/:id/control with the call's id (api-v1-setups.ts).
import express from 'express';
import { requireScope, TokenAuthRequest } from '../middleware/access-token-auth';
import { runFailHttpStatus } from '../services/run-shared';
import fs from 'fs';
import { CALL_NOT_FOUND, callSetup, getSetupCall } from '../services/setup-call';
import { callInputOf } from '../services/setup-call-input';
import { dropFileCall, prepareFileCall, startFileCall } from '../services/setup-call-file';
import { scanCsvFile, CsvHeaderCollisionError } from '../lib/csv-import-parse';
import { importCsv } from '../services/csv-import';
import { MAX_CSV_UPLOAD_BYTES } from '../lib/constants';
import { csvUploadMiddleware } from './sheets-shared';
import { callEnrichment } from '../services/enrich-call';
import { ceilingArgsOf } from '../lib/cost-ceiling';

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
    { hasSecretsScope: !!req.tokenScopes?.has('secrets') });
  if ('fail' in out) {
    // Over the ceiling: 409 with the estimate it was checked against (over_ceiling: true).
    const over = out.fail === 'over_ceiling' ? { over_ceiling: true, estimate: out.estimate } : {};
    return res.status(runFailHttpStatus(out)).json({ error: out.message, ...over });
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

// { items, fields, estimate_only (default false), max_cost_usd, allow_unpriced, webhook_id }: one enrichment tool on
// items without a sheet (services/enrich-call.ts). 200 with the estimate, 202 with the run (GET /v1/http-runs/:id
// and its /results answer for it), 409 with over_ceiling when it could pass a limit.
router.post('/enrichments/:toolId/calls', requireScope('run'),
  guarded('POST /v1/enrichments/:toolId/calls', async (req, res) => {
    const b = body(req);
    if (b.estimate_only !== undefined && typeof b.estimate_only !== 'boolean') {
      return res.status(400).json({ error: 'estimate_only must be true or false.' });
    }
    if (b.fields !== undefined && !(Array.isArray(b.fields) && b.fields.every(f => typeof f === 'string'))) {
      return res.status(400).json({ error: 'fields must be an array of field names.' });
    }
    const ceiling = ceilingArgsOf(b.max_cost_usd, b.allow_unpriced);
    if ('error' in ceiling) return res.status(400).json({ error: ceiling.error });
    const caller = { userId: req.userId!, tokenId: req.accessTokenId!, scopes: req.tokenScopes ?? new Set<string>() };
    const out = await callEnrichment(caller, {
      toolId: req.params.toolId, items: b.items, fields: b.fields as string[] | undefined,
      estimateOnly: b.estimate_only === true, ...ceiling,
      webhookId: typeof b.webhook_id === 'string' ? b.webhook_id : null,
    });
    if ('fail' in out) {
      const over = out.fail === 'over_ceiling' ? { over_ceiling: true, estimate: out.estimate } : {};
      const status = out.fail === 'rate_limited' ? 429
        : runFailHttpStatus(out as Parameters<typeof runFailHttpStatus>[0]);
      return res.status(status).json({ error: out.message, ...over });
    }
    return res.status('run_id' in out.ok ? 202 : 200).json(out.ok);
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
