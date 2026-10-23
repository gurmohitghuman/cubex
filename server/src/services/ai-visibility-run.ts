// Asking an AI visibility table's engines: one implementation for the app's
// guide, /api/v1 and MCP. Each engine column is an ordinary enrichment column,
// so this is its column menu's run, column by column: the questions not asked
// yet (or every question, `again`: a fresh answer for each), with one
// estimate summed over the engines first. Estimates are pure reads.
// The columns are found by what fills them (an engine's tool), never by name:
// a renamed column is still asked.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { getColumnTypes } from '../lib/column-types';
import { ENGINES } from '../lib/ai-visibility/engines';
import { newestColumnRun } from './enrich-column';
import { sheetFree } from './ai-visibility-columns';
import { rerunEnrichmentColumn, type RerunEstimate } from './enrich-rerun';
import type { DailyLimitView } from './treg-key';
import type { RunFail } from './run-shared';

export interface AiVisibilityRecord {
  id: string; table_id: string; questions_sheet_id: string; sites_sheet_id: string | null; brand: string;
  competitors: string; domain: string | null; country: string; engines: string;
}

export interface EngineEstimate {
  column: string; rows: number; lowUsd: number; highUsd: number; priceKnown: boolean;
}
export interface AskEstimate {
  engines: EngineEstimate[]; rows: number; lowUsd: number; highUsd: number; dailyLimit: DailyLimitView | null;
  problems: string[];   // an engine column that can't be asked now, and why
}
export interface AskStarted { started: Array<{ column: string; runId: string; rows: number }>; problems: string[] }

const TOOLS = new Set(ENGINES.map(e => e.toolId));
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function aiVisibilityRecord(userId: string, id: string): AiVisibilityRecord | null {
  return (db.prepare(`SELECT v.* FROM ai_visibility v JOIN sheets s ON s.id = v.questions_sheet_id
    WHERE v.id = ? AND v.user_id = ? AND s.trash_id IS NULL`).get(id, userId) as AiVisibilityRecord | undefined)
    ?? null;
}

export function aiVisibilityForSheet(userId: string, sheetId: string): AiVisibilityRecord | null {
  return (db.prepare(`SELECT v.* FROM ai_visibility v JOIN sheets s ON s.id = v.questions_sheet_id
    WHERE v.questions_sheet_id = ? AND v.user_id = ? AND s.trash_id IS NULL`)
    .get(sheetId, userId) as AiVisibilityRecord | undefined) ?? null;
}

// A table by its id or by its questions sheet's id (what list_tables shows).
export const aiVisibilityFor = (userId: string, idOrSheet: unknown): AiVisibilityRecord | null =>
  (typeof idOrSheet === 'string'
    ? aiVisibilityRecord(userId, idOrSheet) ?? aiVisibilityForSheet(userId, idOrSheet) : null);

// The questions sheet's engine columns, in its order.
export function engineColumnsOf(userId: string, sheetId: string): string[] {
  const types = getColumnTypes(sheetId, userId);
  return getSheetColumns(sheetId, userId).filter(c => types[c] === 'enrich-status'
    && TOOLS.has(newestColumnRun(sheetId, userId, c)?.config.enrichment.toolId ?? ''));
}

const rowsFor = (again: boolean) => ({ mode: 'all' as const, status: again ? 'any' as const : 'not_enriched' as const,
  test: null, rowIndexes: null });

export async function estimateAsk(userId: string, rec: AiVisibilityRecord, again: boolean): Promise<AskEstimate> {
  const out: AskEstimate = { engines: [], rows: 0, lowUsd: 0, highUsd: 0, dailyLimit: null, problems: [] };
  for (const column of engineColumnsOf(userId, rec.questions_sheet_id)) {
    const r = await rerunEnrichmentColumn(userId, rec.questions_sheet_id, {
      column, rows: rowsFor(again), estimateOnly: true, spendLimitUsd: null, rowGeneration: null, callAgain: again,
    });
    if (!('ok' in r) || !('estimate' in r.ok)) {
      out.problems.push(`${column}: ${'message' in r ? r.message : "can't be estimated"}`);
      continue;
    }
    const e: RerunEstimate = r.ok.estimate;
    out.engines.push({ column, rows: e.rows, lowUsd: e.lowUsd, highUsd: e.highUsd, priceKnown: e.priceKnown });
    out.rows = Math.max(out.rows, e.rows);
    out.lowUsd = round6(out.lowUsd + e.lowUsd);
    out.highUsd = round6(out.highUsd + e.highUsd);
    out.dailyLimit = e.dailyLimit;
  }
  return out;
}

// Starts each engine column with questions to ask, one after the other (a
// start holds the sheet while it marks its rows; a sheet still busy after the
// wait stops the rest). A column with nothing to ask is passed by quietly; one
// that can't start (a run of it still going, no treg key, the daily limit) is
// a problem, and the others start all the same. refuse: an agent's check
// before each start (its token's spend cap and run-start window), whose
// refusal stops the rest.
export async function startAsk(
  userId: string, rec: AiVisibilityRecord, again: boolean, refuse: () => string | null = () => null,
): Promise<AskStarted | RunFail> {
  const columns = engineColumnsOf(userId, rec.questions_sheet_id);
  if (columns.length === 0) return { fail: 'bad_request', message: 'This table has no engine columns left to ask.' };
  const out: AskStarted = { started: [], problems: [] };
  const req = (column: string, estimateOnly: boolean) => ({
    column, rows: rowsFor(again), estimateOnly, spendLimitUsd: null, rowGeneration: null, callAgain: again,
  });
  for (const [i, column] of columns.entries()) {
    if (!(await sheetFree(rec.questions_sheet_id))) {
      out.problems.push(`The sheet is still busy, so ${columns.slice(i).join(', ')} wasn't asked. Ask again soon.`);
      break;
    }
    const est = await rerunEnrichmentColumn(userId, rec.questions_sheet_id, req(column, true));
    if ('ok' in est && 'estimate' in est.ok && est.ok.estimate.rows === 0) continue;
    const refused = refuse();
    if (refused) { out.problems.push(`${column}: ${refused}`); break; }
    const r = await rerunEnrichmentColumn(userId, rec.questions_sheet_id, req(column, false));
    if ('ok' in r && 'runId' in r.ok) out.started.push({ column, runId: r.ok.runId, rows: r.ok.rowsInScope });
    else if (!(r as { nothingToRun?: boolean }).nothingToRun) {
      out.problems.push(`${column}: ${'message' in r ? r.message : "didn't start"}`);
    }
  }
  return out;
}

// The record as the app, /api/v1 and MCP show it.
export interface AiVisibilityView {
  id: string; tableId: string; questionsSheetId: string; sitesSheetId: string | null; brand: string;
  competitors: string[]; domain: string | null; country: string; engines: string[];
}
const list = (s: string): string[] => {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
};
export const aiVisibilityView = (r: AiVisibilityRecord): AiVisibilityView => ({
  id: r.id, tableId: r.table_id, questionsSheetId: r.questions_sheet_id, sitesSheetId: r.sites_sheet_id,
  brand: r.brand, competitors: list(r.competitors), domain: r.domain, country: r.country, engines: list(r.engines),
});
