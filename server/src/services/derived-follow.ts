// Auto-run on a derived column (an autorun_columns entry of kind 'clean' or
// 'formula', derived-kind.ts): the column follows its inputs. An enrichment or
// HTTP API column's auto-run fills a row once; a derived column works a row
// out again whenever one of its inputs is written (lib/autorun-mark.ts queues
// every such row, whatever the column's cell holds), and works out the new
// rows above its watermark. A person's own edit to its cell stays until an
// input changes again. It's free and has no side effects, so there are no
// caps and no "Only run if". Each slice reads and writes in one short
// transaction, so what it writes is the row's inputs as they are then, and
// nothing holds the sheet between slices (lib/sheet-yield.ts doesn't apply).
import { db } from '../lib/db';
import { CLEAN_FOLLOW_KICK_MS, CLEAN_FOLLOW_TICK_MS, HEAVY_SLICE_ROWS } from '../lib/constants';
import { jsonPath } from '../lib/sql-rows';
import { getSheetColumns } from '../lib/sql-helpers';
import { yieldToRequests } from '../lib/slices';
import { sheetBusyWith } from '../lib/sheet-busy';
import { markAutorunInputs } from '../lib/autorun-mark';
import { onFollowQueued } from '../lib/autorun-kick';
import { clearEntryPause, loadEntry, pauseEntry, type AutorunEntry } from './autorun-entry';
import { generationMoved, hasWork } from './autorun-fence';
import type { DerivedKind, DerivedPass, DerivedRecord } from './derived-kind';
import { derivedKindOf } from './derived-kinds';
import { asDerivedRead, derivedSelect, pageAfter, readDerivedRows, writeDerivedCells } from './derived-write';

// page: how many rows the next slice reads (derived-write.ts pageAfter).
interface Step {
  kind: DerivedKind; entry: AutorunEntry; rec: DerivedRecord; pass: DerivedPass; inputs: string[]; page: number;
}

// Inside each slice's transaction: the sheet is free and the column is set up
// as when the tick began. Between slices a sort, an import, a rename, a delete
// or an edit of the column can start; this tick's slices then stop.
function stillCurrent(s: Step): boolean {
  if (sheetBusyWith(s.entry.sheet_id)) return false;
  const now = s.kind.forColumn(s.entry.sheet_id, s.entry.user_id, s.rec.column_name);
  const e = loadEntry(s.entry.id);
  return !!now && !!e && now.id === s.rec.id && now.fill_status === 'done' && s.kind.sameSetup(now, s.rec)
    && e.enabled === 1 && e.kind === s.kind.id && e.status_column === s.rec.column_name && e.paused_reason !== 'user';
}

const cellPathOf = (s: Step) => jsonPath(s.rec.column_name);

// Rows an input was written in, a slice a transaction. True while there are more.
function queuedSlice(s: Step): boolean {
  const e = s.entry;
  let more = false;
  db.transaction(() => {
    if (!stillCurrent(s)) return;
    const sel = derivedSelect(s.rec.column_name, s.inputs, 'r.');
    const read = readDerivedRows(db.prepare(`SELECT p.row_id AS id, r.rowid AS rowid, r.row_index AS i,
        r.sheet_id AS sheet, ${sel.sql}
      FROM autorun_pending p LEFT JOIN rows r ON r.id = p.row_id
      WHERE p.autorun_id = ? ORDER BY p.row_id LIMIT ?`)
      .iterate(...sel.params, e.id, s.page), s.page, s.inputs.length);
    const rows = read.rows;
    // A row gone (deleted, or replaced by an import) just leaves the queue. The
    // rest are written in storage order, and leave it once worked out.
    const live = rows.filter(r => r.sheet === e.sheet_id).sort((a, b) => (a.rowid as number) - (b.rowid as number));
    const reads = live.map(r => asDerivedRead(r, s.inputs.length));
    const counts = writeDerivedCells(e.user_id, cellPathOf(s), reads, s.pass);
    const worked = new Set(live.slice(0, counts.done).map(r => r.id));
    const leave = rows.filter(r => r.sheet !== e.sheet_id || worked.has(r.id)).map(r => r.id);
    db.prepare('DELETE FROM autorun_pending WHERE autorun_id = ? AND row_id IN (SELECT value FROM json_each(?))')
      .run(e.id, JSON.stringify(leave));
    finishSlice(s, counts.changed);
    more = read.capped || counts.done < live.length;
    s.page = pageAfter(s.page, live.length, counts.done);
  }).immediate();
  return more;
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
    const sel = derivedSelect(s.rec.column_name, s.inputs);
    const read = readDerivedRows(db.prepare(`SELECT rowid AS rowid, row_index AS i, ${sel.sql}
      FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index > ? ORDER BY row_index LIMIT ?`)
      .iterate(...sel.params, e.sheet_id, e.user_id, fence.w, s.page), s.page, s.inputs.length);
    const rows = read.rows.map(r => asDerivedRead(r, s.inputs.length));
    if (rows.length === 0) return;
    // A new row whose inputs are empty keeps a cell it arrived with.
    const counts = writeDerivedCells(e.user_id, cellPathOf(s), rows, s.pass, { keepWhenEmpty: true });
    if (counts.done > 0) {
      db.prepare('UPDATE autorun_columns SET watermark_row_index = ? WHERE id = ?').run(rows[counts.done - 1].i, e.id);
    }
    finishSlice(s, counts.changed);
    more = read.capped || counts.done < rows.length;
    s.page = pageAfter(s.page, rows.length, counts.done);
  }).immediate();
  return more;
}

function finishSlice(s: Step, changed: number[]): void {
  if (changed.length === 0) return;
  // Columns worked out from this one (and other auto-runs reading it) follow in turn.
  markAutorunInputs(s.entry.sheet_id, s.entry.user_id, [s.entry.status_column], { rowids: changed });
  db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?`).run(s.entry.sheet_id, s.entry.user_id);
}

// Whether the entry can follow its inputs now. An input or the column gone
// pauses it until a column by that name is back; then the pause lifts here.
function ready(kind: DerivedKind, e: AutorunEntry, rec: DerivedRecord | undefined): rec is DerivedRecord {
  if (!rec || rec.fill_status === 'filling') return false;
  const columns = getSheetColumns(e.sheet_id, e.user_id, false);
  const gone = [...kind.inputs(rec), rec.column_name].find(c => !columns.includes(c));
  if (gone) {
    pauseEntry(e.id, 'missing_input', `${gone} isn't in this sheet anymore. Auto-run waits until it's back.`);
    return false;
  }
  if (e.paused_reason === 'missing_input') clearEntryPause(e.id, 'missing_input');
  return true;
}

const ticking = new Set<string>();
const again = new Set<string>();

export async function derivedFollowTick(e: AutorunEntry): Promise<void> {
  const kind = derivedKindOf(e.kind);
  // Paused by the person, or stopped ('setup', 'too_slow') until the column is
  // saved again or auto-run turned on again. A missing input lifts in ready().
  if (!kind || (e.paused_reason && e.paused_reason !== 'missing_input') || sheetBusyWith(e.sheet_id)) return;
  // One tick per entry at a time; a kick meanwhile runs once more after it.
  if (ticking.has(e.id)) { again.add(e.id); return; }
  ticking.add(e.id);
  try {
    const rec = kind.forColumn(e.sheet_id, e.user_id, e.status_column);
    if (!ready(kind, e, rec) || generationMoved(e) || !hasWork(e)) return;
    const pass = await kind.open(rec);
    if ('error' in pass) {
      pauseEntry(e.id, 'setup', pass.error);
      return;
    }
    try {
      const s: Step = { kind, entry: e, rec, pass, inputs: kind.inputs(rec), page: HEAVY_SLICE_ROWS };
      const until = Date.now() + CLEAN_FOLLOW_TICK_MS;
      for (let more = true; more;) {
        await pass.prepare();
        // Queued rows first (a person's edit), then new ones.
        more = queuedSlice(s) || newSlice(s);
        const failure = pass.failure();
        if (failure) {
          pauseEntry(e.id, 'too_slow', `${failure} Auto-run is paused; turn it on again once it's fixed.`);
          return;
        }
        if (more && (Date.now() >= until || sheetBusyWith(e.sheet_id))) { again.add(e.id); return; }
        if (more) await yieldToRequests();
      }
    } finally {
      pass.dispose();
    }
  } finally {
    ticking.delete(e.id);
    if (again.delete(e.id)) kickDerivedFollow(e.id);
  }
}

const kicked = new Set<string>();

// Follows the inputs soon, not at the next auto-run sweep (API process only).
export function kickDerivedFollow(entryId: string): void {
  if (kicked.has(entryId)) return;
  kicked.add(entryId);
  setTimeout(() => {
    kicked.delete(entryId);
    const e = loadEntry(entryId);
    if (e?.enabled && derivedKindOf(e.kind)) {
      derivedFollowTick(e).catch(err => console.error(`Auto-run on column "${e.status_column}" failed:`, err));
    }
  }, CLEAN_FOLLOW_KICK_MS).unref?.();
}

// At boot (API process): a write that queues rows for a derived column kicks it.
export function startDerivedFollow(): void {
  onFollowQueued(kickDerivedFollow);
}
