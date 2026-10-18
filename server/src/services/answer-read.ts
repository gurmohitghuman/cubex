// The answer panel's read (GET /api/enrich/sheets/:id/answer?column=&row=): a
// cell's stored answer from the newest run with a result at that row, what
// the row shows for that run's columns, and for an enrichment who found it,
// what it cost and each call it made (the ledger, by the row's stable id).
// HTTP API columns get the result and the full response. A pure read.
import { db } from '../lib/db';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { parseStored, readStored } from '../lib/answer-store';
import { answerSource, callSteps, triedProviders, type Access, type CallStep, type LedgerRow, type TriedProvider }
  from '../lib/answer-steps';
import { columnRuns, resultAtRow } from './answer-runs';
import type { RunFail } from './run-shared';
import { isWaterfallConfig } from '../lib/waterfall/config';

const LEDGER_MAX = 100;

export interface EnrichAnswerInfo {
  toolId: string; toolName: string;
  foundBy: string | null; access: Access | null;
  costUsd: number | null;       // what the row's answer cost (a replay counts its first charge)
  sameLookup: boolean;          // reused another row's identical lookup in the run: no call of its own
  // Filled from a found answer an earlier run stored (services/enrich-reuse.ts):
  // when treg gave it, and the sheet it was bought for (null: deleted since).
  reused: { answeredAt: string; sheetId: string | null; sheetName: string | null } | null;
  calls: CallStep[];
  tried: TriedProvider[];
}

export interface AnswerView {
  kind: 'enrichment' | 'http';
  column: string; statusColumn: string; rowIndex: number;
  runId: string; runAt: string;
  status: 'completed' | 'failed';
  reason: string | null;
  result: Array<{ column: string; value: string }>;
  answer: unknown;              // null when nothing was kept (a failed or skipped row)
  trimmed: string[];            // parts too big to keep
  prunedAt: string | null;      // when the raw part was removed to save space
  mapping: Array<{ columnName: string; jsonPath: string }>;
  enrichment: EnrichAnswerInfo | null;
  // A list job: its results became rows in this sheet (null: deleted since).
  addsRowsTo: { sheetId: string | null; name: string | null } | null;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function rowCells(sheetId: string, userId: string, rowIndex: number): { id: string; data: Json } | null {
  const row = db.prepare('SELECT id, data FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index = ?')
    .get(sheetId, userId, rowIndex) as { id: string; data: string } | undefined;
  if (!row) return null;
  try {
    const data = JSON.parse(row.data);
    return { id: row.id, data: isObj(data) ? data : {} };
  } catch { return { id: row.id, data: {} }; }
}

// One read transaction: the row, its result and its calls come from one
// snapshot, so a sort committing meanwhile can't pair one row's id with
// another row's answer.
export function readAnswer(
  userId: string, sheetId: string, column: string, rowIndex: number,
): { ok: AnswerView } | RunFail {
  return db.transaction(() => readAnswerNow(userId, sheetId, column, rowIndex))();
}

const reusedInfo = (userId: string, from: unknown): EnrichAnswerInfo['reused'] => {
  if (!isObj(from) || typeof from.answered_at !== 'string' || typeof from.sheet_id !== 'string') return null;
  const name = db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL').pluck()
    .get(from.sheet_id, userId) as string | undefined;
  return { answeredAt: from.answered_at, sheetId: name === undefined ? null : from.sheet_id, sheetName: name ?? null };
};

function readAnswerNow(
  userId: string, sheetId: string, column: string, rowIndex: number,
): { ok: AnswerView } | RunFail {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const owner = columnRuns(sheetId, userId, column);
  if (!owner) return { fail: 'bad_request', message: `"${column}" isn't an enrichment or HTTP API column.` };
  const row = rowCells(sheetId, userId, rowIndex);
  if (!row) return { fail: 'not_found', message: 'That row is gone. Reload the sheet.' };
  const hit = resultAtRow(owner.runs, userId, rowIndex);
  if (!hit) return { fail: 'not_found', message: 'This row has no stored answer yet.' };

  const { run } = hit;
  // A waterfall's row tells its story step by step (services/waterfall-trace.ts).
  if (isWaterfallConfig(run.config)) {
    return { fail: 'bad_request', message: `"${column}" is a waterfall column: read its trace instead.` };
  }
  const mapping = (run.config?.responseMapping ?? []).map(m => ({ columnName: m.columnName, jsonPath: m.jsonPath }));
  const result = [owner.statusColumn, ...mapping.map(m => m.columnName)].map(c => {
    const v = row.data[c];
    return { column: c, value: typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v) };
  });
  const raw = parseStored(hit.response_data);
  const stored = run.enrichment ? readStored(raw) : { body: raw, trimmedPaths: [], prunedAt: null };
  const view: AnswerView = {
    kind: run.enrichment ? 'enrichment' : 'http', column, statusColumn: owner.statusColumn, rowIndex,
    runId: run.id, runAt: run.createdAt, status: hit.status === 'failed' ? 'failed' : 'completed',
    reason: hit.error_message, result, answer: stored.body ?? null,
    trimmed: stored.trimmedPaths, prunedAt: stored.prunedAt, mapping, enrichment: null, addsRowsTo: null,
  };
  const list = run.enrichment?.enrichment.list;
  if (list) {
    const name = db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL').pluck()
      .get(list.destSheetId, userId) as string | undefined;
    view.addsRowsTo = { sheetId: name === undefined ? null : list.destSheetId, name: name ?? null };
  }
  const e = run.enrichment?.enrichment;
  if (e) {
    const ledger = db.prepare(`SELECT attempt, tool_id, call_id, cost_micro, original_cost_micro, http_status,
        treg_error, served_by, served_via, tier, cache_hit, replay, created_at
      FROM enrichment_calls WHERE run_id = ? AND row_id = ? AND +user_id = ?
      ORDER BY created_at, rowid LIMIT ?`).all(run.id, row.id, userId, LEDGER_MAX) as LedgerRow[];
    const body = stored.body;
    const cubex = isObj(body) && isObj(body._cubex) ? body._cubex : {};
    const reused = reusedInfo(userId, cubex.reused_from);
    view.enrichment = {
      toolId: e.toolId, toolName: e.toolName, ...answerSource(body), costUsd: hit.cost_usd,
      sameLookup: typeof cubex.same_as_row_index === 'number', reused,
      calls: callSteps(ledger, body, e.providerNames),
      // A reused answer's providers were asked (and paid) by the earlier run, not this row.
      tried: reused ? [] : triedProviders(body, e.providerNames),
    };
  }
  return { ok: view };
}
