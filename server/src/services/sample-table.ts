// The sample table: one implementation for the app, /api/v1 and the MCP tool.
// A new table "Sample leads" with one sheet of 25 made-up leads
// (lib/sample/leads.ts) and the columns that show what Cubex does: the free
// ones filled (a clean column, a formula column) and a duplicate check of the
// one duplicate the rows hold, while the AI column is only set up: an empty
// "Good fit (Output)" column and the AI Column drawer's saved draft (prompt and
// name; the model only when the account has a default). Nothing that costs
// money runs: that takes the person's click, or an agent's run_ai_column.
// The table, its rows, descriptions and draft go in one transaction, then the
// free columns through their own services, one at a time (each holds the
// sheet busy while it fills). It is an ordinary table: deleting it puts it in
// the trash. Its History opens with "Made the sample sheet", which is also how
// the app knows to show the sample's guide (isSampleSheet).
import { db } from '../lib/db';
import { appendColumnsToOrder } from '../lib/sql-helpers';
import { sheetBusyWith } from '../lib/sheet-busy';
import { logSheetChange, withoutChangeLog } from '../lib/change-log';
import { writeColumnDescription } from '../lib/column-descriptions';
import { upsertDraftConfig } from '../lib/ai-drafts';
import { resolveAiModel } from '../lib/ai-model-resolve';
import { DEFAULT_AI_CONCURRENCY, SAMPLE_STEP_POLL_MS, SAMPLE_STEP_WAIT_MS } from '../lib/constants';
import { SAMPLE_COLUMNS, SAMPLE_ROWS } from '../lib/sample/leads';
import {
  SAMPLE_AI_COLUMN, SAMPLE_AI_NAME, SAMPLE_AI_PROMPT, SAMPLE_AI_TRY_ROWS, SAMPLE_CLEAN, SAMPLE_COLUMN_DESCRIPTIONS,
  SAMPLE_COLUMN_ORDER,
  SAMPLE_DEDUPE_COLUMNS, SAMPLE_FORMULA, SAMPLE_SHEET_DESCRIPTION, SAMPLE_SHEET_NAME, SAMPLE_TABLE_NAME,
} from '../lib/sample/setup';
import { createTable } from './table-crud';
import { appendRows } from './rows-write';
import { startCleanColumn } from './clean-column';
import { startFormulaColumn } from './formula-column';
import { checkDuplicates, type DedupeCheck } from './dedupe-check';
import { reorderSheetColumns } from './column-reorder';

export interface SampleTable {
  tableId: string; tableName: string; sheetId: string; sheetName: string; rows: number;
  filled: string[];                 // the free columns, filled
  ai: { column: string; name: string; prompt: string; model: string | null; tryRowIds: string[] };
  duplicates: DedupeCheck | null;   // the check of the Email column
  problems: string[];               // a free step that didn't finish; the table is there all the same
}

export type SampleOutcome = { ok: SampleTable } | { fail: 'bad_request'; message: string };

// "Sample leads", or "Sample leads 2", 3… when a live table has the name.
function freeTableName(userId: string): string {
  const taken = new Set(db.prepare(`SELECT name FROM tables WHERE user_id = ? AND trash_id IS NULL
    AND name LIKE ?`).pluck().all(userId, `${SAMPLE_TABLE_NAME}%`) as string[]);
  let name = SAMPLE_TABLE_NAME;
  for (let n = 2; taken.has(name); n++) name = `${SAMPLE_TABLE_NAME} ${n}`;
  return name;
}

// The table, its sheet, rows and words, and the AI draft: all or nothing.
type Made = { tableId: string; tableName: string; sheetId: string; rowIds: string[] };
function makeTable(userId: string): Made | { fail: 'bad_request'; message: string } {
  return db.transaction(() => {
    const made = withoutChangeLog(() => createTable(userId, freeTableName(userId)));
    if ('fail' in made) return { fail: 'bad_request' as const, message: made.message };
    const { id: tableId, name: tableName, sheetId } = made.ok;
    logSheetChange(sheetId, userId, 'sample_created', 'Made the sample sheet: 25 made-up leads',
      { detail: { rows: SAMPLE_ROWS.length } });
    db.prepare('UPDATE sheets SET name = ?, description = ? WHERE id = ? AND user_id = ?')
      .run(SAMPLE_SHEET_NAME, SAMPLE_SHEET_DESCRIPTION, sheetId, userId);
    appendColumnsToOrder(sheetId, userId, [...SAMPLE_COLUMNS]);
    const rows = appendRows(sheetId, userId, SAMPLE_ROWS.map(r => ({ ...r })));
    if ('fail' in rows) throw new Error(`The sample rows didn't go in: ${rows.fail}`);
    for (const column of SAMPLE_COLUMNS) {
      writeColumnDescription(sheetId, userId, column, SAMPLE_COLUMN_DESCRIPTIONS[column]);
    }
    // The AI Column drawer opens with this (GET /api/ai/drafts/:sheetId). No model:
    // the drawer takes the defaults as they are when it opens, and Cubex never picks one.
    const sheetGen = db.prepare('SELECT row_generation FROM sheets WHERE id = ?').pluck().get(sheetId) as number;
    upsertDraftConfig(userId, sheetId, {
      columnName: SAMPLE_AI_NAME, prompt: SAMPLE_AI_PROMPT, systemPrompt: null,
      model: '', temperature: 0.2,
      useOpenRouterWebSearch: false, useWebFetch: false, maxChars: null, concurrency: DEFAULT_AI_CONCURRENCY,
      runIf: null,
    }, sheetGen);
    return { tableId, tableName, sheetId, rowIds: rows.ok.rows.map(r => r.id) };
  }).immediate();
}

// Waits for the fill before to let go of the sheet; false when it's still going.
async function sheetFree(sheetId: string): Promise<boolean> {
  for (const until = Date.now() + SAMPLE_STEP_WAIT_MS; sheetBusyWith(sheetId);) {
    if (Date.now() > until) return false;
    await new Promise(resolve => setTimeout(resolve, SAMPLE_STEP_POLL_MS));
  }
  return true;
}

// A column Cubex made, with its words, in one go.
function describe(sheetId: string, userId: string, column: string): void {
  db.transaction(() => {
    writeColumnDescription(sheetId, userId, column, SAMPLE_COLUMN_DESCRIPTIONS[column]);
    db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?`).run(sheetId, userId);
  }).immediate();
}

export async function createSampleTable(userId: string): Promise<SampleOutcome> {
  const made = makeTable(userId);
  if ('fail' in made) return made;
  const { sheetId } = made;
  const filled: string[] = [];
  const problems: string[] = [];
  // Its own History line says it all: the steps log nothing of their own. The table
  // is there whatever a step does, so a step that throws is a problem, not a failure.
  await withoutChangeLog(() => addColumns(userId, sheetId, filled, problems)).catch((e: Error) => {
    problems.push(`Setting up the columns stopped: ${e.message}`);
  });
  const check = await checkDuplicates(userId, sheetId, { columns: SAMPLE_DEDUPE_COLUMNS, keep: 'first' })
    .catch((e: Error) => ({ fail: 'bad_request' as const, message: e.message }));
  if ('fail' in check) problems.push(`The duplicate check didn't finish: ${check.message}`);
  for (const p of problems) console.error(`Sample table ${made.tableId}: ${p}`);
  return {
    ok: {
      tableId: made.tableId, tableName: made.tableName, sheetId, sheetName: SAMPLE_SHEET_NAME,
      rows: SAMPLE_ROWS.length, filled,
      ai: {
        column: SAMPLE_AI_COLUMN, name: SAMPLE_AI_NAME, prompt: SAMPLE_AI_PROMPT,
        model: resolveAiModel(undefined, sheetId, userId), tryRowIds: made.rowIds.slice(0, SAMPLE_AI_TRY_ROWS),
      },
      duplicates: 'ok' in check ? check.ok : null, problems,
    },
  };
}

// The free columns (each filled before the next starts), the AI column and the order.
async function addColumns(userId: string, sheetId: string, filled: string[], problems: string[]): Promise<void> {
  const clean = await startCleanColumn(userId, sheetId, { ...SAMPLE_CLEAN });
  if ('fail' in clean) problems.push(`The clean column didn't start: ${clean.message}`);
  else { describe(sheetId, userId, SAMPLE_CLEAN.column); filled.push(SAMPLE_CLEAN.column); }
  if (!(await sheetFree(sheetId))) problems.push('The clean column is still filling.');
  const formula = await startFormulaColumn(userId, sheetId, { ...SAMPLE_FORMULA });
  if ('fail' in formula) problems.push(`The formula column didn't start: ${formula.message}`);
  else { describe(sheetId, userId, SAMPLE_FORMULA.column); filled.push(SAMPLE_FORMULA.column); }
  if (!(await sheetFree(sheetId))) problems.push('The formula column is still filling.');
  // Empty: a run of "Good fit" fills it.
  db.transaction(() => appendColumnsToOrder(sheetId, userId, [SAMPLE_AI_COLUMN])).immediate();
  describe(sheetId, userId, SAMPLE_AI_COLUMN);
  // Each column beside the one it reads. Skipped when a free column is missing.
  if (problems.length === 0) {
    const placed = reorderSheetColumns(sheetId, userId, SAMPLE_COLUMN_ORDER, { bumpDataVersion: true });
    if ('fail' in placed) problems.push(`The columns couldn't be put in order: ${placed.error}`);
  }
}

// Whether the sheet is a sample sheet: its History opens with the line
// createSampleTable writes (one step down the (sheet_id, id) index). History
// keeps CHANGE_LOG_DAYS, so the guide goes once that line is pruned: fine for
// a first look.
export function isSampleSheet(sheetId: string, userId: string): boolean {
  return db.prepare(`SELECT action FROM sheet_changes WHERE sheet_id = ? AND user_id = ? ORDER BY id LIMIT 1`)
    .pluck().get(sheetId, userId) === 'sample_created';
}
