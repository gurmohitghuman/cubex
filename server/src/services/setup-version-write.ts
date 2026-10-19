// Writing one column's setup back from a version (services/setup-version-restore.ts),
// inside the restore's transaction. Nothing runs and nothing is billed:
//   - an AI, HTTP API, enrichment or waterfall column gets a run record that
//     ran nothing (setup_only, status completed, no rows, migration 043), so
//     its newest run (what its reruns, auto-run, edit dialogs and details read)
//     is the version's. Its usage record goes: usage lists what ran.
//   - a clean, formula or lookup column gets its record back as filled
//     ('done'): its cells stay as they are until it's worked out again. Its
//     auto-run, already on, keeps its fence (KEEP).
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { compileFormula } from '../lib/formula/refs';
import { lookupColumnFor } from '../lib/lookup-columns';
import { mappedColumns, type AiFill, type CleanFill, type FormulaFill, type HttpFill, type LookupFill }
  from '../lib/setup-versions/spec';
import { setDerivedAutorun } from './derived-autorun';
import { ensureLookupSource, releaseLookupSource } from './lookup-source';

// Nothing fills it now: an auto-run already on keeps its fence (rows that came
// meanwhile are still worked out); one turned on starts above the rows there.
const KEEP = { keepFence: true };

const forgetUsage = (runId: string) => db.prepare('DELETE FROM run_usage WHERE run_id = ?').run(runId);

export function writeAiSetup(sheetId: string, userId: string, column: string, f: AiFill): string {
  const id = uuidv4();
  const structured = !!f.outputColumns?.length;
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, system_prompt, model, temperature,
      use_openrouter_web_search, use_web_fetch, max_chars, concurrency, status, total_rows, processed_rows,
      output_columns, status_column, data_column, web_search_engine, web_search_mode, web_search_max_per_row,
      web_search_engine_used, run_if, setup_only)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 5), 'completed', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(id, sheetId, userId, column, f.prompt, f.systemPrompt, f.model, f.temperature, f.webSearch ? 1 : 0,
      f.webFetch ? 1 : 0, f.maxChars, f.concurrency, structured ? JSON.stringify(f.outputColumns) : null,
      structured ? column : null, f.dataColumn, f.searchEngine, f.searchMode, f.maxSearchesPerRow,
      f.searchEngineUsed ?? null, f.runIf);
  forgetUsage(id);
  return id;
}

// columns: the sheet's columns once the restore has added its own back. A
// caller that can't use saved keys freezes them off, as its reruns would.
export function writeHttpSetup(
  sheetId: string, userId: string, column: string, f: HttpFill, columns: string[], hasSecretsScope: boolean,
): string {
  const id = uuidv4();
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, processed_rows,
      master_column_name, allow_secrets, dest_sheet_id, setup_only)
    VALUES (?, ?, ?, ?, 'completed', 0, 0, ?, ?, ?, 1)`)
    .run(id, sheetId, userId, JSON.stringify(f.config), column, hasSecretsScope ? f.allowSecrets : 0, f.destSheetId);
  // A column it no longer fills loses its links (a rerun puts ⏳ in every
  // linked column: one it doesn't write would wait forever). Earlier runs keep
  // their links to the columns it still fills: an answer is found through them.
  const mapped = mappedColumns(f.config);
  db.prepare(`DELETE FROM http_column_associations WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    AND extracted_column_name NOT IN (SELECT value FROM json_each(?))`)
    .run(sheetId, userId, column, JSON.stringify(mapped));
  const assoc = db.prepare(`INSERT INTO http_column_associations (id, sheet_id, user_id, master_column_name,
    extracted_column_name, run_id) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const c of mapped) {
    if (c !== column && columns.includes(c)) assoc.run(uuidv4(), sheetId, userId, column, c, id);
  }
  forgetUsage(id);
  return id;
}

export function writeCleanSetup(sheetId: string, userId: string, column: string, f: CleanFill, autoRun: boolean) {
  db.prepare(`INSERT INTO clean_columns (id, user_id, sheet_id, column_name, source_column, cleaner, options,
      fill_status) VALUES (?, ?, ?, ?, ?, ?, ?, 'done')
    ON CONFLICT(sheet_id, column_name) DO UPDATE SET source_column = excluded.source_column,
      cleaner = excluded.cleaner, options = excluded.options, fill_status = 'done', fill_cursor = 0,
      error_message = NULL, updated_at = datetime('now')`)
    .run(uuidv4(), userId, sheetId, column, f.source, f.cleaner, JSON.stringify(f.options));
  setDerivedAutorun('clean', sheetId, userId, column, [f.source], autoRun, KEEP);
}

// columns: the sheet's columns once the restore has added its own back.
export function writeFormulaSetup(
  sheetId: string, userId: string, column: string, f: FormulaFill, autoRun: boolean, columns: string[],
) {
  const compiled = compileFormula(f.formula, columns);
  db.prepare(`INSERT INTO formula_columns (id, user_id, sheet_id, column_name, formula, inputs, description,
      fill_status) VALUES (?, ?, ?, ?, ?, ?, ?, 'done')
    ON CONFLICT(sheet_id, column_name) DO UPDATE SET formula = excluded.formula, inputs = excluded.inputs,
      description = excluded.description, fill_status = 'done', fill_cursor = 0, error_message = NULL,
      updated_at = datetime('now')`)
    .run(uuidv4(), userId, sheetId, column, compiled.formula, JSON.stringify(compiled.inputs), f.description);
  setDerivedAutorun('formula', sheetId, userId, column, compiled.inputs, autoRun, KEEP);
  return compiled.inputs;
}

export function writeLookupSetup(sheetId: string, userId: string, column: string, f: LookupFill, autoRun: boolean) {
  const prior = lookupColumnFor(sheetId, userId, column);
  db.prepare(`INSERT INTO lookup_columns (id, user_id, sheet_id, column_name, source_column, other_sheet_id,
      match_column, match_mode, returns, return_columns, list_limit, fill_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done')
    ON CONFLICT(sheet_id, column_name) DO UPDATE SET source_column = excluded.source_column,
      other_sheet_id = excluded.other_sheet_id, match_column = excluded.match_column,
      match_mode = excluded.match_mode, returns = excluded.returns, return_columns = excluded.return_columns,
      list_limit = excluded.list_limit, broken = NULL, fill_status = 'done', fill_cursor = 0,
      error_message = NULL, updated_at = datetime('now')`)
    .run(uuidv4(), userId, sheetId, column, f.source, f.otherSheetId, f.matchColumn, f.match, f.returns,
      f.returnColumns ? JSON.stringify(f.returnColumns) : null, f.limit);
  // The other sheet's column is indexed (in the background, free) so a fill or a follow can match it.
  ensureLookupSource(userId, f.otherSheetId, f.matchColumn, f.match === 'contains');
  if (prior && (prior.other_sheet_id !== f.otherSheetId || prior.match_column !== f.matchColumn)) {
    releaseLookupSource(userId, prior.other_sheet_id, prior.match_column);
  }
  setDerivedAutorun('lookup', sheetId, userId, column, [f.source], autoRun, KEEP);
}
