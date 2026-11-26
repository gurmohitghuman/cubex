// Saving a column's setup without running it (the app's Save, save_only over REST and MCP). The new setup
// becomes the column's newest run record, one that ran nothing (setup_only 3, as setup versions write them:
// migration 043), so its next run, rerun and auto-run use it. Cells stay as they are, and so does what reads
// out of date: each row is checked against what its own run read (lib/run-inputs/sets.ts). Each start
// (ai-run-start.ts, http-run-start.ts, enrich-run-start.ts, waterfall-run-start.ts) makes every check it
// makes for a run first, then calls here instead of seeding rows. Synchronous from the caller's conflict check
// to the write, so no run can start on the column in between.
import { db } from '../lib/db';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { appendColumnsToOrder, countColumnsAndRows, getSheetColumns } from '../lib/sql-helpers';
import { logSetupSaved, type RunLog } from '../lib/change-log';
import { busyMessage, sheetBusyWith } from '../lib/sheet-busy';
import type { AiFill, HttpFill } from '../lib/setup-versions/spec';
import { SETUP_SAVED, writeAiSetup, writeHttpSetup } from './setup-version-write';

export type SetupSaveOutcome =
  | { ok: { setupId: string; added: string[] } } | { fail: 'cap' | 'conflict'; message: string };
type SaveLog = Omit<Parameters<typeof logSetupSaved>[2], 'setupId'>;

// A list enrichment makes its sheet when it first runs: it can't be saved without running yet.
export const SAVE_ONLY_LIST = 'A list enrichment\'s setup can\'t be saved without running yet: run it on a few '
  + 'rows instead.';

// A structured (several-column) AI setup can't be saved without running yet.
export const SAVE_ONLY_STRUCTURED = 'A setup that fills several columns from one call can\'t be saved without '
  + 'running yet: run it, or save a one-column setup.';

// In one immediate transaction: the column limit, the columns it adds (listed first), the record, the log line.
// guard: asked again inside the write lock, for a start that awaited the network after its own checks.
function saveWith(
  sheetId: string, userId: string, columns: readonly string[], log: SaveLog,
  write: () => string, guard?: () => string | null,
): SetupSaveOutcome {
  return db.transaction((): SetupSaveOutcome => {
    // A sort, import or column rewrite that began while the start awaited the network (lib/sheet-busy.ts).
    const busy = sheetBusyWith(sheetId);
    if (busy) return { fail: 'conflict', message: busyMessage(busy) };
    const raced = guard?.();
    if (raced) return { fail: 'conflict', message: raced };
    const listed = new Set(getSheetColumns(sheetId, userId, false));
    const added = columns.filter(c => !listed.has(c));
    if (countColumnsAndRows(sheetId, userId).columns + added.length > MAX_COLUMNS_PER_SHEET) {
      return { fail: 'cap', message: `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet). This setup needs `
        + `${added.length} new column${added.length === 1 ? '' : 's'}: delete unused columns first.` };
    }
    appendColumnsToOrder(sheetId, userId, added);
    const setupId = write();
    logSetupSaved(sheetId, userId, { ...log, setupId });
    return { ok: { setupId, added } };
  }).immediate();
}

// An AI column: its output column (and "(Data)" with web search) and the setup.
export function saveAiSetup(
  sheetId: string, userId: string, outputColumn: string, columns: readonly string[], fill: AiFill,
): SetupSaveOutcome {
  return saveWith(sheetId, userId, columns, { kind: 'ai', column: outputColumn, runIf: fill.runIf },
    () => writeAiSetup(sheetId, userId, outputColumn, fill, SETUP_SAVED));
}

// An HTTP API, enrichment or waterfall column: its main column, the columns it fills, and the setup. A column
// the new setup no longer fills keeps its cells and loses its link (writeHttpSetup).
export function saveHttpSetup(
  sheetId: string, userId: string, kind: Exclude<RunLog['kind'], 'ai'>, master: string, columns: readonly string[],
  fill: HttpFill, runIf: string | null, guard?: () => string | null,
): SetupSaveOutcome {
  return saveWith(sheetId, userId, [master, ...columns], { kind, column: master, runIf },
    () => writeHttpSetup(sheetId, userId, master, fill, getSheetColumns(sheetId, userId, false), true, SETUP_SAVED),
    guard);
}
