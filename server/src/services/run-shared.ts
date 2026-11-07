// Shared shapes + helpers for the run-start/rerun service flows (AI + HTTP)
// and the surfaces that call them (UI routes, /api/v1, MCP tools).
import { db } from '../lib/db';
import { MCP_RUN_STARTS_PER_MIN } from '../lib/api-v1-constants';
import { ROW_ID_RESOLVE_CHUNK } from '../lib/constants';
import { makeRateWindow, tooManyMessage, type RateDecision } from '../lib/rate-window';
import { spendCapRefusal } from './token-spend';
import type { HeldRead, HeldRefusal } from '../lib/run-held-reads';

// Structured failures the start/rerun/control services return instead of
// throwing (expected outcomes keep their message + HTTP mapping identical on
// every surface). Unexpected errors still throw → each surface's 500 handler.
export type RunFailKind =
  | 'not_found'     // 404 — sheet/run missing or not owned
  | 'no_model'      // 400 — no explicit/sheet/account model (never a fallback)
  | 'bad_request'   // 400
  | 'conflict'      // 409 — active run on the column, superseded run, CAS miss
  | 'forbidden'     // 403 — missing scope (e.g. 'secrets' for a key-referencing run)
  | 'cap'           // 400 — column cap
  | 'upstream'      // 502 — a service Cubex reads can't answer now (treg's catalog)
  | 'over_ceiling'; // 409 — its estimate could pass max_cost_usd, or has no price (lib/cost-ceiling.ts)
// field: the request field the failure is about (a new sheet's name: 'destName'),
// so a form can show it in place. nothingToRun: no row is left for it to do (a
// rerun of a column every row of which is done), which a setup counts as done.
// held: a column it reads that another run holds (lib/run-held-reads.ts), which a setup's step waits for.
export interface RunFail { fail: RunFailKind; message: string; field?: string; nothingToRun?: true; held?: HeldRead }

// A start refused for a column another run holds (409), saying which.
export const heldFail = (h: HeldRefusal): RunFail =>
  ({ fail: 'conflict', message: h.message, held: { column: h.column, hold: h.hold } });

export const runFailHttpStatus = (f: RunFail): number =>
  f.fail === 'not_found' ? 404
  : f.fail === 'conflict' || f.fail === 'over_ceiling' ? 409
  : f.fail === 'forbidden' ? 403
  : f.fail === 'upstream' ? 502
  : 400;

// Resolve stable row ids → row_index for a run-target subset. Unknown ids are
// an explicit error — an agent must not silently enrich fewer rows than asked.
// The ids go in as one JSON array a chunk (SQLite takes at most 32,766 bound
// values in a statement, and the surfaces take up to a sheet's rows), each id
// looked up by the primary key.
export function resolveRowIdsToIndexes(
  sheetId: string, userId: string, rowIds: string[],
): { indexes: number[] } | { error: string } {
  const unique = Array.from(new Set(rowIds));
  const lookup = db.prepare(`SELECT r.id, r.row_index FROM json_each(?) AS j CROSS JOIN rows AS r ON r.id = j.value
    WHERE r.sheet_id = ? AND r.user_id = ?`);
  const found: Array<{ id: string; row_index: number }> = [];
  for (let i = 0; i < unique.length; i += ROW_ID_RESOLVE_CHUNK) {
    const chunk = JSON.stringify(unique.slice(i, i + ROW_ID_RESOLVE_CHUNK));
    found.push(...lookup.all(chunk, sheetId, userId) as Array<{ id: string; row_index: number }>);
  }
  if (found.length !== unique.length) {
    const known = new Set(found.map(r => r.id));
    const missing = unique.filter(id => !known.has(id));
    return {
      error: `Unknown row id(s): ${missing.slice(0, 5).join(', ')}`
        + (missing.length > 5 ? ` (+${missing.length - 5} more)` : ''),
    };
  }
  return { indexes: found.map(r => r.row_index).sort((a, b) => a - b) };
}

// Run-start window, keyed per access token and shared by MCP and /api/v1
// (lib/rate-window.ts). Agents can loop, and every run start spends model
// credits, so starts get this guard on top of the per-token request limit
// (lib/limits.ts apiV1Limiter). Each call takes a slot when one is free.
export const runStartWindow = makeRateWindow(MCP_RUN_STARTS_PER_MIN);

// A token starting a run, a rerun or a preview: refused while it is at its
// spend cap (services/token-spend.ts, no slot taken), else it takes a slot. A
// plain HTTP API run (paid false) costs nothing here: only the slot.
export type StartRefusal = { capped: string } | { limited: RateDecision };
export function takeRunStart(userId: string, tokenId: string, paid = true): StartRefusal | null {
  const capped = spendCapRefusal(userId, tokenId, paid ? null : 'free');
  if (capped) return { capped };
  const slot = runStartWindow(tokenId);
  return slot.allowed ? null : { limited: slot };
}
export const startRefusalMessage = (r: StartRefusal): string =>
  ('capped' in r ? r.capped : tooManyMessage('run starts', r.limited));
