// HTTP-shaped helpers for the /api/v1 sub-routers. The underlying data-plane
// logic lives in services/data-plane-shared.ts (shared with the MCP tools);
// this module only maps TxnFail outcomes onto Express responses.
import express from 'express';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import { isBusyMessage, type BusyAllowed } from '../lib/sheet-busy';
import { TxnFail, txnFailMessage } from '../services/data-plane-shared';

export { parseCellMap } from '../services/data-plane-shared';

export function failResponse(res: express.Response, f: TxnFail) {
  const status =
    f.fail === 'locked' || f.fail === 'active_run' || f.fail === 'protected_columns' || f.fail === 'busy'
      || f.fail === 'idempotency_conflict' ? 409
    : f.fail === 'not_found' ? 404
    : f.fail === 'sheet_not_found' ? 404
    : 400;
  const body: Record<string, unknown> = { error: txnFailMessage(f, MAX_ROWS_PER_SHEET) };
  if (f.fail === 'unknown_columns') body.unknownColumns = f.columns;
  if (f.fail === 'locked') body.lockedColumns = f.columns;
  if (f.fail === 'protected_columns') body.protectedColumns = f.columns;
  if (f.fail === 'busy') body.busy = true;
  return res.status(status).json(body);
}

// A row write's idempotency key, from the body or the Idempotency-Key header
// (undefined: none; services/rows-write-keyed.ts checks its shape).
export const rawIdempotencyKey = (req: express.Request): unknown =>
  (req.body as { idempotency_key?: unknown } | undefined)?.idempotency_key ?? req.get('Idempotency-Key') ?? undefined;

// The changes to /api/v1/sheets/:id that go through while the sheet is busy
// (lib/sheet-busy.ts). Appending rows lands above the reserved range; a query
// or a check only reads; stopping every run is allowed (a run still writing its
// placeholders holds the sheet); a dry restore only reads, and a restore checks
// the sheet itself (services/setup-version-restore.ts). A many-row update with
// an idempotency key reads the ledger first: a replay writes nothing, and one
// that would write is refused there (services/rows-write-keyed.ts). A run start
// with a key replays its first start, even while that start still sets up its
// rows; any other keyed start is refused as busy right after (run-start-token.ts
// busyRefusal).
const KEYED_RUN_STARTS = new Set(['/ai-runs', '/http-runs', '/enrichment-runs', '/waterfall-columns']);
export const V1_SHEET_BUSY_ALLOWED: BusyAllowed[] = [
  '/rows', '/rows/query', '/run-conditions/check', '/run-conditions/generate', '/formula-columns/write',
  '/setups', '/setups/plan', /^\/setups\/[^/]+\/apply$/, '/runs/stop',
  /^\/setup-versions\/[^/]+\/restore$/,
  req => req.path === '/rows/update' && rawIdempotencyKey(req) !== undefined,
  req => KEYED_RUN_STARTS.has(req.path) && rawIdempotencyKey(req) !== undefined,
];

// A run start's refusal as JSON. One for a busy sheet says busy: true, as the busy guard's does (lib/sheet-busy.ts).
export const runFailBody = (message: string) => ({ error: message, ...(isBusyMessage(message) ? { busy: true } : {}) });
