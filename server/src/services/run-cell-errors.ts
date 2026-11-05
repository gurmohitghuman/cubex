// The full error text behind run cells that read as failed, for read_rows'
// and REST rows/query's `row_ids` with include_status. A failed HTTP API row
// writes only "❌ Error" in its cells, an AI run's "(Data)" column "❌ Error",
// and an enrichment a reason cut to 120 characters; the whole message is in the
// run's result at the row. Found as the answer panel finds a row's answer
// (services/answer-runs.ts): the state column's runs newest first, one probe of
// the (run_id, row_index) index per run for the rows still unanswered, each
// row stopping at its newest result. A column can hold tens of thousands of
// runs (auto-run makes one per batch), so the walk stops after RUN_ERROR_PROBES
// probes: rows not reached keep their cell's words. Page reads don't look.
import { db } from '../lib/db';
import { RUN_ERROR_PROBES } from '../lib/constants-query';
import { cellStatus } from '../lib/row-filter/cell-status';

type Raw = { id: string; row_index: number; data: Record<string, string> };
type Hit = { row_index: number; status: string; error_message: string | null };

const cell = (data: Record<string, string>, c: string) =>
  (Object.prototype.hasOwnProperty.call(data, c) ? data[c] ?? '' : '');

// State column → the row indexes where a cell it holds the state of reads as failed.
function failedCells(rows: Raw[], runs: ReadonlyMap<string, string>, columns?: readonly string[]) {
  const asks = new Map<string, Set<number>>();
  const read = (columns ?? [...runs.keys()]).filter(c => runs.has(c));
  for (const r of rows) {
    for (const column of read) {
      const state = runs.get(column)!;
      if (cellStatus(cell(r.data, column), state === column ? '' : cell(r.data, state)) !== 'error') continue;
      if (!asks.has(state)) asks.set(state, new Set());
      asks.get(state)!.add(r.row_index);
    }
  }
  return asks;
}

// The column's runs, newest first: an AI run's main column wins over an HTTP
// one of the same name (lib/column-types.ts).
function stateRuns(sheetId: string, userId: string, state: string): { ai: boolean; ids: string[] } {
  const ai = db.prepare(`SELECT id FROM ai_runs WHERE sheet_id = ? AND user_id = ? AND column_name = ?
    ORDER BY rowid DESC`).pluck().all(sheetId, userId, state) as string[];
  if (ai.length > 0) return { ai: true, ids: ai };
  const http = db.prepare(`SELECT id FROM http_runs WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    ORDER BY created_at DESC, rowid DESC`).pluck().all(sheetId, userId, state) as string[];
  return { ai: false, ids: http };
}

// row id → state column → the error its run recorded, for failed cells only.
export function fullRunErrors(
  sheetId: string, userId: string, rows: Raw[], runs: ReadonlyMap<string, string>, columns?: readonly string[],
): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const asks = failedCells(rows, runs, columns);
  if (asks.size === 0) return out;
  const idAt = new Map(rows.map(r => [r.row_index, r.id]));
  // Newest result first (an AI run can hold more than one at a row). Undone
  // results aren't the row's (migration 044); pending ones aren't answers yet.
  const probes = {
    ai: db.prepare(`SELECT row_index, status, error_message FROM ai_results
      WHERE run_id = ? AND row_index IN (SELECT value FROM json_each(?)) AND +user_id = ? AND undone = 0
        AND status != 'pending' ORDER BY rowid DESC`),
    http: db.prepare(`SELECT row_index, status, error_message FROM http_results
      WHERE run_id = ? AND row_index IN (SELECT value FROM json_each(?)) AND +user_id = ? AND undone = 0
        AND status != 'pending'`),
  };
  let spent = 0;
  for (const [state, wanted] of asks) {
    const { ai, ids } = stateRuns(sheetId, userId, state);
    const left = new Set(wanted);
    for (const runId of ids) {
      if (left.size === 0 || spent >= RUN_ERROR_PROBES) break;
      spent += left.size;
      const hits = (ai ? probes.ai : probes.http).all(runId, JSON.stringify([...left]), userId) as Hit[];
      for (const h of hits) {
        if (!left.delete(h.row_index)) continue;
        if (h.status !== 'failed' || !h.error_message) continue;
        const rowId = idAt.get(h.row_index)!;
        if (!out.has(rowId)) out.set(rowId, new Map());
        out.get(rowId)!.set(state, h.error_message);
      }
    }
  }
  return out;
}
