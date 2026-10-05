// Shared shapes + helpers for the run-start/rerun service flows (AI + HTTP)
// and the surfaces that call them (UI routes, /api/v1, MCP tools).
import { db } from '../lib/db';
import { MCP_RUN_STARTS_PER_MIN } from '../lib/api-v1-constants';
import { makeRateWindow } from '../lib/rate-window';

// Structured failures the start/rerun/control services return instead of
// throwing (expected outcomes keep their message + HTTP mapping identical on
// every surface). Unexpected errors still throw → each surface's 500 handler.
export type RunFailKind =
  | 'not_found'     // 404 — sheet/run missing or not owned
  | 'no_model'      // 400 — no explicit/sheet/account model (never a fallback)
  | 'bad_request'   // 400
  | 'conflict'      // 409 — active run on the column, superseded run, CAS miss
  | 'forbidden'     // 403 — missing scope (e.g. 'secrets' for a key-referencing run)
  | 'cap';          // 400 — column cap
export interface RunFail { fail: RunFailKind; message: string }

export const runFailHttpStatus = (f: RunFail): number =>
  f.fail === 'not_found' ? 404
  : f.fail === 'conflict' ? 409
  : f.fail === 'forbidden' ? 403
  : 400;

// Resolve stable row ids → row_index for a run-target subset. Unknown ids are
// an explicit error — an agent must not silently enrich fewer rows than asked.
export function resolveRowIdsToIndexes(
  sheetId: string, userId: string, rowIds: string[],
): { indexes: number[] } | { error: string } {
  const unique = Array.from(new Set(rowIds));
  const ph = unique.map(() => '?').join(',');
  const found = db.prepare(
    `SELECT id, row_index FROM rows WHERE sheet_id = ? AND user_id = ? AND id IN (${ph})`,
  ).all(sheetId, userId, ...unique) as Array<{ id: string; row_index: number }>;
  if (found.length !== unique.length) {
    const known = new Set(found.map(r => r.id));
    const missing = unique.filter(id => !known.has(id));
    return {
      error: `Unknown row id(s): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''}`,
    };
  }
  return { indexes: found.map(r => r.row_index).sort((a, b) => a - b) };
}

// Run-start window, keyed per access token and shared by MCP and /api/v1
// (lib/rate-window.ts). Agents can loop, and every run start spends model
// credits, so starts get this guard on top of the per-token request limit
// (lib/limits.ts apiV1Limiter). Each call takes a slot when one is free.
export const runStartWindow = makeRateWindow(MCP_RUN_STARTS_PER_MIN);
