// Auto-run on a clean data column (an autorun_columns entry of kind 'clean'):
// the column follows its source. An enrichment or HTTP API column's auto-run
// fills a row once; a clean column cleans a row again whenever its source cell
// is written (lib/autorun-mark.ts queues every such row, whatever the clean
// cell holds), and cleans the new rows above its watermark. A person's own
// edit to the clean cell stays until the source changes again. Cleaning is
// free and has no side effects, so there are no caps and no "Only run if".
// Each slice reads and writes in one short transaction, so what it writes is
// the row's source as it is then, and nothing holds the sheet between slices
// (the user-yield window of lib/sheet-yield.ts doesn't apply).
import { db } from '../lib/db';
import { CLEAN_FOLLOW_KICK_MS, CLEAN_FOLLOW_TICK_MS, HEAVY_SLICE_ROWS } from '../lib/constants';
import { jsonPath } from '../lib/sql-rows';
import { getSheetColumns } from '../lib/sql-helpers';
import { yieldToRequests } from '../lib/slices';
import { sheetBusyWith } from '../lib/sheet-busy';
import { markAutorunInputs } from '../lib/autorun-mark';
import { onCleanQueued } from '../lib/autorun-kick';
import { cleanColumnFor, type CleanColumnRow } from '../lib/clean-columns';
import { cleanerForRecord } from '../lib/clean/cleaners';
import { clearEntryPause, loadEntry, pauseEntry, type AutorunEntry } from './autorun-entry';
import { generationMoved, hasWork } from './autorun-fence';
import { writeCleanCells, type CleanCellRead } from './clean-write';

interface Step {
  entry: AutorunEntry; rec: CleanColumnRow; clean: (v: string) => string; sourcePath: string; cellPath: string;
}

const bumpVersion = (e: AutorunEntry) => db.prepare(`UPDATE sheets SET data_version = data_version + 1,
  updated_at = datetime('now') WHERE id = ? AND user_id = ?`).run(e.sheet_id, e.user_id);

// Inside each slice's transaction: the sheet is free and the column is set up
// as when the tick began. Between slices a sort, an import, a rename, a delete
// or an edit of the cleaner can start; this tick's slices then stop.
function stillCurrent(s: Step): boolean {
  if (sheetBusyWith(s.entry.sheet_id)) return false;
  const now = cleanColumnFor(s.entry.sheet_id, s.entry.user_id, s.rec.column_name);
  const e = loadEntry(s.entry.id);
  return !!now && !!e && now.id === s.rec.id && now.fill_status === 'done' && now.cleaner === s.rec.cleaner
    && now.options === s.rec.options && now.source_column === s.rec.source_column
    && e.enabled === 1 && e.kind === 'clean' && e.status_column === s.rec.column_name && e.paused_reason !== 'user';
}

// Rows whose source was written, a slice a transaction. True while there are more.
function queuedSlice(s: Step): boolean {
  const e = s.entry;
  let n = 0;
  db.transaction(() => {
    if (!stillCurrent(s)) return;
    const rows = db.prepare(`SELECT p.row_id AS id, r.rowid AS rowid, r.sheet_id AS sheet,
        json_extract(r.data, ?) AS source, json_extract(r.data, ?) AS cell
      FROM autorun_pending p LEFT JOIN rows r ON r.id = p.row_id
      WHERE p.autorun_id = ? ORDER BY p.row_id LIMIT ?`)
      .all(s.sourcePath, s.cellPath, e.id, HEAVY_SLICE_ROWS) as Array<CleanCellRead & { id: string; sheet: string }>;
    n = rows.length;
    // A row gone (deleted, or replaced by an import) just leaves the queue. The
    // rest are written in storage order.
    const live = rows.filter(r => r.sheet === e.sheet_id).sort((a, b) => a.rowid - b.rowid);
    const counts = writeCleanCells(e.user_id, s.cellPath, live, s.clean);
    db.prepare('DELETE FROM autorun_pending WHERE autorun_id = ? AND row_id IN (SELECT value FROM json_each(?))')
      .run(e.id, JSON.stringify(rows.map(r => r.id)));
    finishSlice(s, counts.changed);
  }).immediate();
  return n === HEAVY_SLICE_ROWS;
}

// New rows above the watermark, a slice a transaction. The watermark and the
// sheet's row generation are read inside it, so a delete, sort or import that
// moved the fence since the tick began is never passed over.
function newSlice(s: Step): boolean {
  const e = s.entry;
  let more = false;
  db.transaction(() => {
    if (!stillCurrent(s)) return;
    const fence = db.prepare(`SELECT watermark_row_index AS w, row_generation_seen AS g FROM autorun_columns
      WHERE id = ? AND enabled = 1`).get(e.id) as { w: number; g: number } | undefined;
    const gen = db.prepare('SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?')
      .pluck().get(e.sheet_id, e.user_id) as number | undefined;
    if (!fence || gen !== fence.g) return;
    const rows = db.prepare(`SELECT rowid AS rowid, row_index AS i, json_extract(data, ?) AS source,
        json_extract(data, ?) AS cell
      FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ? ORDER BY row_index LIMIT ?`)
      .all(s.sourcePath, s.cellPath, e.sheet_id, e.user_id, fence.w, HEAVY_SLICE_ROWS) as
      Array<CleanCellRead & { i: number }>;
    if (rows.length === 0) return;
    // A new row whose source is empty keeps a clean cell it arrived with.
    const counts = writeCleanCells(e.user_id, s.cellPath, rows, s.clean, { keepWhenEmpty: true });
    db.prepare('UPDATE autorun_columns SET watermark_row_index = ? WHERE id = ?').run(rows[rows.length - 1].i, e.id);
    finishSlice(s, counts.changed);
    more = rows.length === HEAVY_SLICE_ROWS;
  }).immediate();
  return more;
}

function finishSlice(s: Step, changed: number[]): void {
  if (changed.length === 0) return;
  // Columns cleaned from this one (and other auto-runs reading it) follow in turn.
  markAutorunInputs(s.entry.sheet_id, s.entry.user_id, [s.entry.status_column], { rowids: changed });
  bumpVersion(s.entry);
}

// Whether the entry can follow its source now. A source or column that's gone
// pauses it until a column by that name is back; then the pause lifts here.
function ready(e: AutorunEntry, rec: CleanColumnRow | undefined): rec is CleanColumnRow {
  if (!rec || rec.fill_status === 'filling') return false;
  const columns = getSheetColumns(e.sheet_id, e.user_id, false);
  const gone = [rec.source_column, rec.column_name].find(c => !columns.includes(c));
  if (gone) {
    pauseEntry(e.id, 'missing_input', `${gone} isn't in this sheet anymore. Auto-run waits until it's back.`);
    return false;
  }
  if (e.paused_reason === 'missing_input') clearEntryPause(e.id, 'missing_input');
  return true;
}

const ticking = new Set<string>();
const again = new Set<string>();

export async function cleanFollowTick(e: AutorunEntry): Promise<void> {
  if (e.paused_reason === 'user' || sheetBusyWith(e.sheet_id)) return;
  // One tick per entry at a time; a kick meanwhile runs once more after it.
  if (ticking.has(e.id)) { again.add(e.id); return; }
  ticking.add(e.id);
  try {
    const rec = cleanColumnFor(e.sheet_id, e.user_id, e.status_column);
    if (!ready(e, rec) || generationMoved(e) || !hasWork(e)) return;
    const clean = cleanerForRecord(rec.cleaner, rec.options);
    if (!clean) return;
    const s: Step = {
      entry: e, rec, clean, sourcePath: jsonPath(rec.source_column), cellPath: jsonPath(rec.column_name),
    };
    const until = Date.now() + CLEAN_FOLLOW_TICK_MS;
    for (let more = true; more;) {
      // Queued rows first (a person's edit), then new ones.
      more = queuedSlice(s) || newSlice(s);
      if (more && (Date.now() >= until || sheetBusyWith(e.sheet_id))) { again.add(e.id); return; }
      if (more) await yieldToRequests();
    }
  } finally {
    ticking.delete(e.id);
    if (again.delete(e.id)) kickCleanFollow(e.id);
  }
}

const kicked = new Set<string>();

// Follows the source soon, not at the next auto-run sweep (API process only).
export function kickCleanFollow(entryId: string): void {
  if (kicked.has(entryId)) return;
  kicked.add(entryId);
  setTimeout(() => {
    kicked.delete(entryId);
    const e = loadEntry(entryId);
    if (e?.enabled && e.kind === 'clean') {
      cleanFollowTick(e).catch(err => console.error(`Auto-run on clean column "${e.status_column}" failed:`, err));
    }
  }, CLEAN_FOLLOW_KICK_MS).unref?.();
}

// At boot (API process): a write that queues rows for a clean column kicks it.
export function startCleanFollow(): void {
  onCleanQueued(kickCleanFollow);
}
