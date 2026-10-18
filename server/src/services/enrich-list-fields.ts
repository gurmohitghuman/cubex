// The fields a list column can keep, read from its real results (treg returns
// each provider's own rows, and its catalog doesn't say what they hold): the
// results still waiting for fields, else the newest run's stored answers.
// GET /api/enrich/sheets/:id/list-fields. And "Add these rows": picking the
// fields for results that wait (POST, one transaction). Pure read / one write.
import { db } from '../lib/db';
import { ENRICH_LIST_FIELD_SAMPLE } from '../lib/constants';
import { listOf, type EnrichRunConfig } from '../lib/enrich-run-config';
import { discoverFields, itemsOf, type ListField, type ListFieldInfo } from '../lib/enrich-list';
import { parseStored, readStored } from '../lib/answer-store';
import { busyMessage, sheetBusyWith } from '../lib/sheet-busy';
import { newestColumnRun } from './enrich-column';
import { fieldlessRuns, giveFields } from './enrich-list-held';
import type { RunFail } from './run-shared';
import { logSheetChange } from '../lib/change-log';

export interface ListFieldChoices {
  fields: ListFieldInfo[];
  results: number;                 // results read
  waiting: { rows: number; results: number };   // results waiting for fields
  kept: ListField[] | null;        // the column's fields now (null: none picked yet)
  dedupePath: string | null;
  destSheetId: string | null;
}

const ROLLBACK = new Error('rollback');
const notList = (column: string): RunFail => ({ fail: 'bad_request', message: `"${column}" doesn't add rows.` });

// The results waiting for fields: how many, and the first few rows' results to read fields from.
function waitingRows(
  sheetId: string, userId: string, column: string,
): { rows: number; results: number; sample: Array<{ items_json: string }> } {
  const n = db.prepare(`SELECT COUNT(*) AS rows, IFNULL(SUM(li.item_count), 0) AS results
    FROM enrichment_list_items li JOIN http_runs r ON r.id = li.run_id
    WHERE li.source_sheet_id = ? AND li.status = 'pending' AND li.wait_reason = 'fields' AND li.user_id = ?
      AND r.user_id = ? AND r.master_column_name = ?`)
    .get(sheetId, userId, userId, column) as { rows: number; results: number };
  const sample = db.prepare(`SELECT li.items_json FROM enrichment_list_items li JOIN http_runs r ON r.id = li.run_id
    WHERE li.source_sheet_id = ? AND li.status = 'pending' AND li.wait_reason = 'fields' AND li.user_id = ?
      AND r.user_id = ? AND r.master_column_name = ?
    ORDER BY li.created_at, li.rowid LIMIT ?`)
    .all(sheetId, userId, userId, column, ENRICH_LIST_FIELD_SAMPLE) as Array<{ items_json: string }>;
  return { ...n, sample };
}

function storedItems(runId: string, config: EnrichRunConfig): unknown[][] {
  const list = config.enrichment.list!;
  const rows = db.prepare(`SELECT response_data FROM http_results WHERE run_id = ? AND status = 'completed'
    ORDER BY row_index LIMIT ?`).all(runId, ENRICH_LIST_FIELD_SAMPLE) as Array<{ response_data: string | null }>;
  return rows.map(r => itemsOf(readStored(parseStored(r.response_data)).body, list.itemsPath, list.maxItems));
}

export function listFieldChoices(
  userId: string, sheetId: string, column: string,
): { ok: ListFieldChoices } | RunFail {
  const run = newestColumnRun(sheetId, userId, column);
  const list = run ? listOf(run.config) : null;
  if (!run || !list) return notList(column);
  const held = waitingRows(sheetId, userId, column);
  const sets: unknown[][] = [];
  for (const h of held.sample) {
    try { sets.push((JSON.parse(h.items_json) as { items?: unknown[] }).items ?? []); } catch { /* none */ }
  }
  // Results that wait are the newest run's own: its stored answers would count them twice.
  if (held.rows === 0) sets.push(...storedItems(run.id, run.config));
  const items = sets.flat();
  return {
    ok: {
      fields: discoverFields(items), results: items.length,
      waiting: { rows: held.rows, results: held.results },
      kept: list.fields?.length ? list.fields : null, dedupePath: list.dedupe?.path ?? null,
      destSheetId: list.destSheetId || null,
    },
  };
}

// "Add these rows": the fields for results that wait for them.
export function pickListFields(
  userId: string, sheetId: string, column: string, fields: ListField[], dedupePath: string | null,
): { ok: { released: number } } | RunFail {
  // Its rows' cells are written by id, its results by row number: not mid-sort.
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  const runs = fieldlessRuns(sheetId, userId, column);
  if (runs.length === 0) return { fail: 'conflict', message: 'No results are waiting for fields in this column.' };
  let out = { released: 0 } as { released: number } | RunFail;
  try {
    db.transaction(() => {
      // Read again inside the write lock: another tab may have picked them.
      out = giveFields(userId, fieldlessRuns(sheetId, userId, column), fields, dedupePath);
      if ('fail' in out) throw ROLLBACK;
    }).immediate();
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
  if (!('fail' in out)) {
    logSheetChange(sheetId, userId, 'list_fields', `Picked the fields of the rows "${column}" adds`,
      { column, detail: { fields: fields.map(f => f.columnName) } });
  }
  return 'fail' in out ? out : { ok: out };
}
