// The agent surfaces' column-from-answers and list-field actions (MCP
// add_enrichment_field, get_list_fields, add_list_rows; /api/v1 enrichment-
// fields and enrichment-list-fields), over the services the answer panel and
// the drawer's Test step use: answer-field-add.ts and enrich-list-fields.ts.
import { db } from '../lib/db';
import { parseDedupe, parseListFields } from '../lib/enrich-list-input';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { addAnswerField } from './answer-field-add';
import { listFieldChoices, pickListFields } from './enrich-list-fields';
import type { RunFail } from './run-shared';
import { appendAutorunNotice } from './enrich-agent-autorun';
import { strayKey } from '../lib/enrich-agent-args';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const text = (v: unknown, max: number): string | null =>
  (typeof v === 'string' && v.trim() && v.length <= max ? v : null);
const notFound: RunFail = { fail: 'not_found', message: 'Sheet not found' };

export async function agentAddField(
  userId: string, sheetId: string,
  a: { column?: unknown; json_path?: unknown; column_name?: unknown; row_id?: unknown },
): Promise<{ ok: Json } | RunFail> {
  if (!verifySheetOwnership(sheetId, userId)) return notFound;
  const stray = strayKey(a as Json, ['column', 'json_path', 'column_name', 'row_id'], '');
  if (stray) return bad(`${stray} Nothing was changed.`);
  const column = text(a.column, 200), jsonPath = text(a.json_path, 1000), name = text(a.column_name, 200);
  if (!column || !jsonPath || !name) return bad('column, json_path and column_name are required.');
  let row: number | null = null;
  if (a.row_id !== undefined && a.row_id !== null) {
    if (typeof a.row_id !== 'string') return bad('row_id must be a row id.');
    row = db.prepare('SELECT row_index FROM rows WHERE id = ? AND sheet_id = ? AND user_id = ?')
      .pluck().get(a.row_id, sheetId, userId) as number | undefined ?? null;
    if (row === null) return bad('That row isn\'t in this sheet.');
  }
  const out = await addAnswerField(userId, sheetId, { column, jsonPath, name, row });
  if ('fail' in out) return out;
  return {
    ok: {
      column: out.ok.column, filling: true,
      note: 'The column fills from stored answers in the background (no treg calls, no requests). Its cells read '
        + '"⏳ Processing..." until it is done; get_sheet lists it in filling_columns meanwhile.',
    },
  };
}

export function agentListFields(userId: string, sheetId: string, column: unknown): { ok: Json } | RunFail {
  if (!verifySheetOwnership(sheetId, userId)) return notFound;
  const name = text(column, 200);
  if (!name) return bad('Name the column that adds rows.');
  const out = listFieldChoices(userId, sheetId, name);
  if ('fail' in out) return out;
  const c = out.ok;
  return {
    ok: {
      fields: c.fields.map(f => ({ path: f.path, label: f.label, filled: f.filled, sample: f.sample })),
      results_read: c.results,
      waiting_for_fields: c.waiting,
      kept: c.kept?.map(f => ({ path: f.path, column_name: f.columnName })) ?? null,
      dedupe_path: c.dedupePath, destination_sheet_id: c.destSheetId,
    },
  };
}

export async function agentAddListRows(
  userId: string, sheetId: string, a: { column?: unknown; fields?: unknown; dedupe_path?: unknown },
): Promise<{ ok: Json } | RunFail> {
  if (!verifySheetOwnership(sheetId, userId)) return notFound;
  const items = Array.isArray(a.fields) ? a.fields.filter(isObj) : [];
  const stray = strayKey(a as Json, ['column', 'fields', 'dedupe_path'], '')
    ?? items.map(f => strayKey(f, ['path', 'column_name'], 'fields[]')).find(x => x) ?? null;
  if (stray) return bad(`${stray} Nothing was changed.`);
  const column = text(a.column, 200);
  if (!column) return bad('Name the column that adds rows.');
  const fields = parseListFields(Array.isArray(a.fields)
    ? a.fields.map(f => (isObj(f) ? { path: f.path, columnName: f.column_name } : f)) : a.fields);
  if (typeof fields === 'string') return bad(`${fields} Use fields: [{path, column_name}].`);
  if (!fields) return bad('Keep at least one field: fields: [{path, column_name}].');
  const dedupePath = parseDedupe(a.dedupe_path, fields);
  if (dedupePath === undefined) return bad('dedupe_path must be the path of one of the fields you keep.');
  const before = listFieldChoices(userId, sheetId, column);
  const out = pickListFields(userId, sheetId, column, fields, dedupePath);
  if ('fail' in out) return out;
  // The new rows set off the destination's own auto-runs, like any append.
  const dest = 'ok' in before ? before.ok.destSheetId : null;
  const results = 'ok' in before ? before.ok.waiting.results : 0;
  const notice = dest ? await appendAutorunNotice(userId, dest, results) : {};
  return {
    ok: {
      source_rows_released: out.ok.released, ...notice,
      note: 'Their results are being added as rows in the destination sheet; each source row\'s status cell says '
        + '"✅ N rows added" when done. The column keeps these fields for its next runs.',
    },
  };
}
