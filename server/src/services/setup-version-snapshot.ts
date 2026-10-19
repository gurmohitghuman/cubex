// A sheet's setup as it is now, as a version spec (lib/setup-versions/spec.ts):
// every listed column in order with its description, what fills it and its
// auto-run. Reads only what the sheet lists and one newest run per column
// (its settings, never its target rows), never a row. What fills a column
// follows the precedence lib/column-types.ts gives: an HTTP run, an AI run
// over it, then a clean, formula or lookup record.
import { db } from '../lib/db';
import { getSheetColumns } from '../lib/sql-helpers';
import { getColumnTypes } from '../lib/column-types';
import { sheetColumnDescriptions } from '../lib/column-descriptions';
import { sheetCleanColumns } from '../lib/clean-columns';
import { sheetFormulaColumns } from '../lib/formula-columns';
import { lookupReturnColumns, sheetLookupColumns } from '../lib/lookup-columns';
import { httpRunMode } from '../lib/http-run-mode';
import { isFollowKind } from '../lib/autorun-kick';
import { sheetEntries, whereOf } from './autorun-entry';
import type { AutoRunSnap, Fill, HttpFill, VersionSpec } from '../lib/setup-versions/spec';

interface AiRunRow {
  column_name: string; prompt: string; system_prompt: string | null; model: string | null; temperature: number | null;
  max_chars: number | null; concurrency: number | null; use_openrouter_web_search: number; use_web_fetch: number;
  output_columns: string | null; data_column: string | null; web_search_engine: string | null;
  web_search_mode: string | null; web_search_max_per_row: number | null; web_search_engine_used: string | null;
  run_if: string | null;
}

const parsed = <T>(raw: string | null, fallback: T): T => {
  try { return raw === null ? fallback : (JSON.parse(raw) as T) ?? fallback; } catch { return fallback; }
};

function aiFills(sheetId: string, userId: string, listed: Set<string>, fills: Map<string, Fill>): void {
  // One newest run per AI column (MAX(rowid) is the newest insert), its settings only.
  const runs = db.prepare(`SELECT column_name, prompt, system_prompt, model, temperature, max_chars, concurrency,
      use_openrouter_web_search, use_web_fetch, output_columns, data_column, web_search_engine, web_search_mode,
      web_search_max_per_row, web_search_engine_used, run_if
    FROM ai_runs WHERE rowid IN (
    SELECT MAX(rowid) FROM ai_runs WHERE sheet_id = ? AND user_id = ? GROUP BY column_name)`)
    .all(sheetId, userId) as AiRunRow[];
  for (const r of runs) {
    if (!listed.has(r.column_name)) continue;
    const outputs = parsed<unknown>(r.output_columns, null);
    fills.set(r.column_name, {
      kind: 'ai', prompt: r.prompt, systemPrompt: r.system_prompt, model: r.model, temperature: r.temperature,
      maxChars: r.max_chars, concurrency: r.concurrency, webSearch: !!r.use_openrouter_web_search,
      webFetch: !!r.use_web_fetch,
      outputColumns: Array.isArray(outputs) && outputs.length ? outputs.map(o => ({ ...o })) : null,
      dataColumn: r.data_column, searchEngine: r.web_search_engine, searchMode: r.web_search_mode,
      maxSearchesPerRow: r.web_search_max_per_row, searchEngineUsed: r.web_search_engine_used, runIf: r.run_if,
    });
  }
}

function httpFill(sheetId: string, userId: string, master: string, listed: Set<string>): HttpFill | null {
  const run = db.prepare(`SELECT config, allow_secrets, dest_sheet_id FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(sheetId, userId, master) as
    { config: string | null; allow_secrets: number | null; dest_sheet_id: string | null } | undefined;
  const config = parsed<Record<string, any> | null>(run?.config ?? null, null);
  if (!run || !config || typeof config !== 'object' || Array.isArray(config)) return null;
  const extracted = db.prepare(`SELECT DISTINCT extracted_column_name FROM http_column_associations
    WHERE sheet_id = ? AND user_id = ? AND master_column_name = ? AND extracted_column_name IS NOT NULL`)
    .pluck().all(sheetId, userId, master) as string[];
  return {
    kind: 'http', mode: httpRunMode(config), config, allowSecrets: run.allow_secrets ?? 1,
    destSheetId: run.dest_sheet_id, extracted: extracted.filter(c => listed.has(c) && c !== master).sort(),
  };
}

function autoRuns(sheetId: string, userId: string): Map<string, AutoRunSnap> {
  const out = new Map<string, AutoRunSnap>();
  for (const e of sheetEntries(sheetId, userId)) {
    if (!e.enabled) continue;
    out.set(e.status_column, isFollowKind(e.kind)
      ? { where: [], runIf: null, dailyCapUsd: null, dailyRowCap: null }
      : { where: whereOf(e), runIf: e.run_if, dailyRowCap: e.daily_row_cap,
        dailyCapUsd: e.daily_cap_micro === null ? null : e.daily_cap_micro / 1e6 });
  }
  return out;
}

export function snapshotSheet(sheetId: string, userId: string): VersionSpec {
  const columns = getSheetColumns(sheetId, userId, false);
  const listed = new Set(columns);
  const fills = new Map<string, Fill>();
  const types = getColumnTypes(sheetId, userId);
  for (const [column, type] of Object.entries(types)) {
    if ((type !== 'http-master' && type !== 'enrich-status' && type !== 'waterfall') || !listed.has(column)) continue;
    const f = httpFill(sheetId, userId, column, listed);
    if (f) fills.set(column, f);
  }
  aiFills(sheetId, userId, listed, fills);
  for (const r of sheetCleanColumns(sheetId, userId)) {
    if (!listed.has(r.column_name)) continue;
    fills.set(r.column_name, { kind: 'clean', source: r.source_column, cleaner: r.cleaner,
      options: parsed<Record<string, unknown>>(r.options, {}) });
  }
  for (const r of sheetFormulaColumns(sheetId, userId)) {
    if (!listed.has(r.column_name)) continue;
    fills.set(r.column_name, { kind: 'formula', formula: r.formula, description: r.description });
  }
  for (const r of sheetLookupColumns(sheetId, userId)) {
    if (!listed.has(r.column_name)) continue;
    fills.set(r.column_name, { kind: 'lookup', source: r.source_column, otherSheetId: r.other_sheet_id,
      matchColumn: r.match_column, match: r.match_mode, returns: r.returns,
      returnColumns: lookupReturnColumns(r), limit: r.list_limit });
  }
  const descriptions = sheetColumnDescriptions(sheetId, userId);
  const auto = autoRuns(sheetId, userId);
  return {
    v: 1,
    columns: columns.map(name => ({
      name, description: descriptions.get(name) ?? null, fill: fills.get(name) ?? null,
      autoRun: auto.get(name) ?? null,
    })),
  };
}
