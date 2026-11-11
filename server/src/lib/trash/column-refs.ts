// What referred to a column the delete is about to clean up (services/column-delete.ts calls it in its
// transaction, before the cleanup): each place another column, a view or a setting named it. The trash item
// keeps the list (migration 054), and restoring the column names each one that didn't come back
// (column-refs-words.ts). Its own setup, description and place come back, so they are not listed.
// Reads setup only: the sheet's views, webhook mappings, each column's newest run, auto-run settings and
// lookups; never a row, and never every run of a column (one newest run per column).
import { db } from '../db';
import { dropColumn, mapViewColumns, parseHiddenColumns } from '../views/refs';
import { mappedColumns } from '../setup-versions/spec';
import { httpRunMode } from '../http-run-mode';
import { aiRunDataColumn } from '../ai-data-column';
import { lookupReturnColumns, type LookupColumnRow } from '../lookup-columns';

export type DroppedRef =
  | { kind: 'view_hidden' | 'view_filter'; view_id: string; view: string }
  | { kind: 'sheet_filter' }
  | { kind: 'webhook_mapping'; webhook: string; field: string }
  | { kind: 'http_field'; column: string; mode: 'http' | 'enrichment' | 'waterfall'; path: string | null }
  | { kind: 'list_field'; sheet_id: string; sheet: string; column: string }
  | { kind: 'ai_output'; column: string }
  | { kind: 'ai_data'; column: string; search_off: boolean }
  | { kind: 'auto_run'; type: string }
  | { kind: 'auto_run_input'; column: string }
  | { kind: 'lookup_into'; sheet_id: string; sheet: string; column: string; part: 'match' | 'return' }
  | { kind: 'auto_dedupe'; keep: string }
  | { kind: 'undo'; runs: number };

const list = (raw: string | null): unknown[] => {
  try { const v = JSON.parse(raw ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};
const obj = (raw: string | null): Record<string, any> | null => {
  try { const v = JSON.parse(raw ?? 'null'); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  catch { return null; }
};

function viewRefs(sheetId: string, userId: string, column: string, out: DroppedRef[]): void {
  const views = db.prepare(`SELECT id, name, empty_filter, column_filters, row_filter, hidden_columns FROM sheet_views
    WHERE sheet_id = ? AND user_id = ? ORDER BY position, created_at`).all(sheetId, userId) as Array<{
      id: string; name: string; empty_filter: string | null; column_filters: string | null;
      row_filter: string | null; hidden_columns: string | null }>;
  for (const v of views) {
    if (parseHiddenColumns(v.hidden_columns).includes(column)) {
      out.push({ kind: 'view_hidden', view_id: v.id, view: v.name });
    }
    const { hidden_columns: _h, ...filters } = v;
    if (Object.keys(mapViewColumns(filters, dropColumn(column))).length) {
      out.push({ kind: 'view_filter', view_id: v.id, view: v.name });
    }
  }
  const sheet = db.prepare('SELECT empty_filter, column_filters, row_filter FROM sheets WHERE id = ? AND user_id = ?')
    .get(sheetId, userId) as { empty_filter: string | null; column_filters: string | null; row_filter: string | null };
  if (sheet && Object.keys(mapViewColumns(sheet, dropColumn(column))).length) out.push({ kind: 'sheet_filter' });
}

function runRefs(sheetId: string, userId: string, column: string, out: DroppedRef[]): void {
  // Each other column's newest HTTP API, enrichment or waterfall run: the fields it writes here.
  const http = db.prepare(`SELECT master_column_name AS master, config FROM http_runs WHERE rowid IN (
      SELECT MAX(rowid) FROM http_runs WHERE sheet_id = ? AND master_column_name IS NOT NULL
      GROUP BY master_column_name) AND user_id = ? ORDER BY master_column_name`)
    .all(sheetId, userId) as Array<{ master: string; config: string | null }>;
  for (const r of http) {
    const config = obj(r.config);
    if (r.master === column || !config || !mappedColumns(config).includes(column)) continue;
    const m = (config.responseMapping as any[]).find(x => x?.columnName === column);
    out.push({ kind: 'http_field', column: r.master, mode: httpRunMode(config),
      path: typeof m?.jsonPath === 'string' ? m.jsonPath : null });
  }
  // List jobs in other sheets adding rows here: the fields they keep, the columns they copy into.
  const into = db.prepare(`SELECT h.sheet_id, s.name AS sheet, h.master_column_name AS master, h.config
    FROM http_runs h JOIN sheets s ON s.id = h.sheet_id WHERE h.rowid IN (
      SELECT MAX(rowid) FROM http_runs WHERE dest_sheet_id = ? AND user_id = ? GROUP BY sheet_id, master_column_name)
    ORDER BY s.name, h.master_column_name`).all(sheetId, userId) as Array<{
      sheet_id: string; sheet: string; master: string | null; config: string | null }>;
  for (const r of into) {
    const l = obj(r.config)?.enrichment?.list;
    const named = (v: unknown, key: string) => list(JSON.stringify(v ?? [])).some((x: any) => x?.[key] === column);
    if (l && (named(l.fields, 'columnName') || named(l.copy, 'to'))) {
      out.push({ kind: 'list_field', sheet_id: r.sheet_id, sheet: r.sheet, column: r.master ?? '' });
    }
  }
  // Each other AI column's newest run: an output it writes here, or its web sources.
  const ai = db.prepare(`SELECT column_name, output_columns, data_column, use_openrouter_web_search FROM ai_runs
    WHERE rowid IN (SELECT MAX(rowid) FROM ai_runs WHERE sheet_id = ? AND user_id = ? GROUP BY column_name)
    ORDER BY column_name`).all(sheetId, userId) as Array<{ column_name: string; output_columns: string | null;
      data_column: string | null; use_openrouter_web_search: number }>;
  for (const r of ai) {
    if (r.column_name === column || r.column_name.startsWith(' deleted:')) continue;
    if (list(r.output_columns).some((o: any) => o?.columnName === column)) {
      out.push({ kind: 'ai_output', column: r.column_name });
    } else if (aiRunDataColumn(r) === column) {
      // deleteAiRunColumnRefs turns web search off for an "(Output)" column whose "(Data)" goes.
      out.push({ kind: 'ai_data', column: r.column_name,
        search_off: !r.output_columns && column.endsWith(' (Data)') && r.column_name.endsWith(' (Output)') });
    }
  }
}

function settingRefs(sheetId: string, userId: string, column: string, out: DroppedRef[]): void {
  const autoRuns = db.prepare(`SELECT status_column, kind, input_columns, enabled FROM autorun_columns
    WHERE sheet_id = ? AND user_id = ? ORDER BY status_column`).all(sheetId, userId) as Array<{
      status_column: string; kind: string; input_columns: string; enabled: number }>;
  for (const a of autoRuns) {
    if (!a.enabled) continue;
    if (a.status_column === column) out.push({ kind: 'auto_run', type: a.kind });
    else if (list(a.input_columns).includes(column)) out.push({ kind: 'auto_run_input', column: a.status_column });
  }
  const lookups = db.prepare(`SELECT l.*, s.name AS sheet FROM lookup_columns l JOIN sheets s ON s.id = l.sheet_id
    WHERE l.other_sheet_id = ? AND l.user_id = ? AND l.broken IS NULL ORDER BY s.name, l.column_name`)
    .all(sheetId, userId) as Array<LookupColumnRow & { sheet: string }>;
  for (const l of lookups) {
    const returned = (lookupReturnColumns(l) ?? []).includes(column);
    const part = l.match_column === column ? 'match' : returned ? 'return' : null;
    if (part) out.push({ kind: 'lookup_into', sheet_id: l.sheet_id, sheet: l.sheet, column: l.column_name, part });
  }
  const hooks = db.prepare(`SELECT s.name, m.json_path FROM webhook_mappings m
    JOIN webhook_sources s ON s.id = m.source_id WHERE s.sheet_id = ? AND s.user_id = ? AND m.column_name = ?
    ORDER BY s.name, m.json_path`)
    .all(sheetId, userId, column) as Array<{ name: string; json_path: string }>;
  for (const h of hooks) out.push({ kind: 'webhook_mapping', webhook: h.name, field: h.json_path });
  const dedupe = db.prepare('SELECT keep FROM auto_dedupe WHERE sheet_id = ? AND user_id = ? AND column_name = ?')
    .pluck().get(sheetId, userId, column) as string | undefined;
  if (dedupe) out.push({ kind: 'auto_dedupe', keep: dedupe });
  const undos = db.prepare(`SELECT COUNT(*) FROM run_undos WHERE sheet_id = ? AND user_id = ?
    AND state IN ('kept', 'undoing') AND EXISTS (SELECT 1 FROM json_each(run_undos.columns) WHERE value = ?)`)
    .pluck().get(sheetId, userId, column) as number;
  if (undos > 0) out.push({ kind: 'undo', runs: undos });
}

// Call inside the delete's transaction, before it cleans anything up.
export function columnRefs(sheetId: string, userId: string, column: string): DroppedRef[] {
  const out: DroppedRef[] = [];
  viewRefs(sheetId, userId, column, out);
  runRefs(sheetId, userId, column, out);
  settingRefs(sheetId, userId, column, out);
  return out;
}
