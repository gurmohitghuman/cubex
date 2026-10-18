// "+ Column" on an answer value (POST /api/enrich/sheets/:id/fields): a new
// column filled from the answers the sheet already holds, free (no treg
// calls, no requests). In ONE transaction inside the sheet's busy window: the
// column joins the registry, the fill is journaled (enrichment_field_jobs),
// the newest run's responseMapping gains the path so later runs fill it too,
// and the column is linked to the newest run. The fill then runs in the
// background with the sheet still busy (answer-field-fill.ts): it links the
// column to the older runs whose answers it reads, then fills the rows.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { appendColumnsToOrder, getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import {
  columnCollisionMessage, findColumnNameCollision, sanitizeAndValidateColumnName,
} from '../lib/column-names';
import { validateHttpJsonPath } from '../lib/jsonpath-extract';
import { busyMessage, continueInBackground, sheetBusyWith, withSheetBusy } from '../lib/sheet-busy';
import { parseStored, readStored } from '../lib/answer-store';
import { droppedLabel, droppedPartFor } from '../lib/answer-paths';
import {
  columnRuns, newestColumnRun, resultAtRow, runDetail, statusColumnRuns, type ColumnRunRef, type RunDetail,
} from './answer-runs';
import { columnRunActive } from './autorun-entry';
import { runFieldJob } from './answer-field-fill';
import type { RunFail } from './run-shared';
import { isWaterfallConfig } from '../lib/waterfall/config';
import { logSheetChange } from '../lib/change-log';

export interface AddFieldInput { column: string; jsonPath: string; name: string; row: number | null }
export type AddFieldOutcome = { ok: { column: string; jobId: string } } | RunFail;

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const activeMessage = (col: string) =>
  `A run on ${col} is still active. Wait for it to finish, or stop it, then add the column.`;

// The answer the path was picked from (the row's), else the newest stored one.
function sampleAnswer(runs: ColumnRunRef[], userId: string, row: number | null): unknown {
  if (row !== null) return parseStored(resultAtRow(runs, userId, row)?.response_data ?? null);
  const raw = db.prepare(`SELECT response_data FROM http_results WHERE run_id = ? AND user_id = ?
    AND response_data IS NOT NULL ORDER BY row_index DESC LIMIT 1`).pluck().get(runs[0].id, userId) as
    string | undefined;
  return parseStored(raw ?? null);
}

// A path into a part of the answer Cubex didn't keep would fill nothing.
function droppedProblem(runs: ColumnRunRef[], userId: string, input: AddFieldInput): RunFail | null {
  const s = readStored(sampleAnswer(runs, userId, input.row));
  const dropped = droppedPartFor(input.jsonPath, s.trimmedPaths, s.prunedAt !== null);
  if (!dropped) return null;
  return bad(s.prunedAt !== null && !s.trimmedPaths.includes(dropped)
    ? 'The details of this answer (raw) were removed to save space, so that value can\'t become a column.'
    : `That part of the answer (${droppedLabel(dropped)}) was too big to keep, so it can't become a column.`);
}

function nameProblem(sheetId: string, userId: string, name: string): RunFail | null {
  const columns = getSheetColumns(sheetId, userId, false);
  const clash = findColumnNameCollision(name, columns);
  if (clash) return bad(columnCollisionMessage(name, clash));
  if (columns.length >= MAX_COLUMNS_PER_SHEET) {
    return {
      fail: 'cap', message: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). Delete unused columns first.`,
    };
  }
  return null;
}

// The newest run fills the path from now on; an enrichment remembers it came
// from an answer, so a rerun doesn't check it against the tool's catalog.
function addToNewestRun(run: RunDetail, userId: string, name: string, path: string): void {
  if (!run.config) return;
  const mapping = [...run.config.responseMapping, { columnName: name, jsonPath: path }];
  const config = { ...run.config, responseMapping: mapping };
  const e = run.enrichment?.enrichment;
  const next = e
    ? { ...config, enrichment: { ...e, answerFields: [...new Set([...(e.answerFields ?? []), path])] } }
    : config;
  db.prepare('UPDATE http_runs SET config = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(next), run.id, userId);
}

export async function addAnswerField(
  userId: string, sheetId: string, input: AddFieldInput,
): Promise<AddFieldOutcome> {
  const busy = sheetBusyWith(sheetId);
  if (busy) return { fail: 'conflict', message: busyMessage(busy) };
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const path = validateHttpJsonPath(input.jsonPath);
  if (!path.ok) return bad(path.reason ?? 'That path is not valid.');
  const owner = columnRuns(sheetId, userId, input.column);
  if (!owner) return bad(`"${input.column}" isn't an enrichment or HTTP API column.`);
  const runs = statusColumnRuns(sheetId, userId, owner.statusColumn);
  const newest = runs.length ? runDetail(runs[0].id, userId) : null;
  if (!newest) return bad(`"${input.column}" isn't an enrichment or HTTP API column.`);
  // A waterfall's cells come from its steps, not a path in one answer.
  if (isWaterfallConfig(newest.config)) {
    return bad(`"${owner.statusColumn}" is a waterfall column: change what it finds with Edit waterfall.`);
  }
  if (newest.enrichment?.enrichment.list) {
    return bad('This column adds its results as rows in another sheet. Pick the fields it keeps with Edit enrichment.');
  }
  if (columnRunActive(sheetId, userId, owner.statusColumn)) {
    return { fail: 'conflict', message: activeMessage(owner.statusColumn) };
  }
  // One column per path: a second would read the same value, and later runs fill outputs by path.
  const mapped = newest.config?.responseMapping.find(m => m.jsonPath === input.jsonPath);
  if (mapped) return bad(`That value is already a column: ${mapped.columnName}.`);
  if (newest.enrichment) {
    const dropped = droppedProblem(runs, userId, input);
    if (dropped) return dropped;
  }
  const v = sanitizeAndValidateColumnName(input.name);
  if ('error' in v) return bad(v.error);
  const name = v.name;
  const early = nameProblem(sheetId, userId, name);
  if (early) return early;

  const jobId = uuidv4();
  const out = await withSheetBusy(sheetId, 'adding a column', async (): Promise<AddFieldOutcome> => {
    let problem = null as RunFail | null;
    db.transaction(() => {
      // Again inside the write lock: a run may have started since the checks.
      const top = newestColumnRun(sheetId, userId, owner.statusColumn);
      const now = top ? runDetail(top.id, userId) : null;
      if (!now || columnRunActive(sheetId, userId, owner.statusColumn)) {
        problem = { fail: 'conflict', message: activeMessage(owner.statusColumn) };
        return;
      }
      problem = nameProblem(sheetId, userId, name);
      if (problem) return;
      appendColumnsToOrder(sheetId, userId, [name]);
      db.prepare(`INSERT INTO enrichment_field_jobs (id, user_id, sheet_id, status_column, column_name, json_path)
        VALUES (?, ?, ?, ?, ?, ?)`).run(jobId, userId, sheetId, owner.statusColumn, name, input.jsonPath);
      addToNewestRun(now, userId, name, input.jsonPath);
      // The newest run now; the column's other runs in the fill's first stage
      // (answer-field-fill.ts), so a column with thousands of runs doesn't
      // hold the write lock here.
      db.prepare(`INSERT INTO http_column_associations
          (id, sheet_id, user_id, master_column_name, extracted_column_name, run_id) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(uuidv4(), sheetId, userId, owner.statusColumn, name, now.id);
      db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
        WHERE id = ? AND user_id = ?`).run(sheetId, userId);
    }).immediate();
    if (problem) return problem;
    continueInBackground(sheetId, 'filling a column', () => runFieldJob(jobId));
    logSheetChange(sheetId, userId, 'answer_field',
      `Added the column "${name}" from the answers of "${owner.statusColumn}"`,
      { column: name, detail: { from_column: owner.statusColumn } });
    return { ok: { column: name, jobId } };
  });
  return 'busy' in out && typeof out.busy === 'string'
    ? { fail: 'conflict', message: out.busy } : out as AddFieldOutcome;
}
