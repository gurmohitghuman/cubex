// Whether what a lookup's fill reads in the other sheet changed, unseen, since its last look, asked each time
// a fill with rows written would go on: then it looks every row up again from the first, so every row comes
// from one version of those values (lookups are free: a start over costs only time). A change: a fill of a
// column it reads ended (a clean, formula or lookup column, stored answers added as a column, a run's undo:
// fillEnded counts them here, a rename carrying the count), a run writing one started (a new run row), a
// paused one went on (its worker_generation moved) or ended (cancelled: its clear puts the ⏳ cells back to
// what they held before it, lib/run-undo/clear-back.ts), a column it read is gone there (renamed or deleted; one
// added isn't a change), or that sheet's rows moved (row_generation: a sort, a replace by an import or its
// undo, removing duplicates). Not an auto-run batch run, nor a set-up-only one (lookup-fill-wait.ts). Nothing
// is missed in this process (renaming a column a value lookup reads starts it over for nothing); a fill it
// finds with rows written and no look of its own (a restart) starts over.
//
// Each fill starts over at most LOOKUP_FILL_START_OVERS times for a change; past that it goes on where it was,
// and its note (kept after the fill ends, until it starts again) names what kept changing, as it's called now.
// Over 200 lines: one check over one in-memory state (its looks, fill-end counts, start overs, the note).
import { db } from '../lib/db';
import { LOOKUP_FILL_START_OVERS } from '../lib/constants';
import { getSheetColumns } from '../lib/sheet-columns';
import { addAiRunColumns, addHttpRunColumns, type AiRunWrites, type HttpRunWrites } from '../lib/run-locked-columns';
import type { LookupColumnRow } from '../lib/lookup-columns';

type Rec = Pick<LookupColumnRow, 'id' | 'user_id' | 'other_sheet_id' | 'fill_cursor'>;
export type LookupChange = { column: string } | { rows: true } | { unknown: true };

type RunTable = 'ai_runs' | 'http_runs';
const TABLES: RunTable[] = ['ai_runs', 'http_runs'];
type RunRow = AiRunWrites & HttpRunWrites & { id: string; gen: number };
// Runs there a fill counts (not set up only, nor an auto-run batch) with the columns they write: those
// above a rowid, or the paused ones.
const RUNS = {
  ai_runs: {
    above: () => db.prepare(`SELECT id, worker_generation AS gen, column_name, output_columns, data_column
      FROM ai_runs WHERE sheet_id = ? AND +user_id = ? AND setup_only = 0 AND rowid > ?`),
    paused: () => db.prepare(`SELECT id, worker_generation AS gen, column_name, output_columns, data_column
      FROM ai_runs WHERE sheet_id = ? AND +user_id = ? AND setup_only = 0
        AND status IN ('pending','running','paused') AND status = 'paused'`),
  },
  http_runs: {
    above: () => db.prepare(`SELECT id, worker_generation AS gen, config, master_column_name FROM http_runs
      WHERE sheet_id = ? AND +user_id = ? AND setup_only = 0 AND autorun_id IS NULL AND rowid > ?`),
    paused: () => db.prepare(`SELECT id, worker_generation AS gen, config, master_column_name FROM http_runs
      WHERE sheet_id = ? AND +user_id = ? AND setup_only = 0 AND autorun_id IS NULL
        AND status IN ('pending','running','paused') AND status = 'paused'`),
  },
};

// What a look saw in the other sheet.
interface Base {
  other: string;
  reads: string[];              // the columns it read there
  fills: Map<string, number>;   // its fills ended so far, per column
  rowGen: number;
  tops: Record<RunTable, number>;                        // the rowid of its newest run
  paused: Map<string, { gen: number; column: string }>;  // paused runs writing a column it reads
}
// What kept changing past its start overs: a column of that sheet, or (null) its rows.
type Kept = { other: string; column: string | null };
interface Fill { user: string; base: Base | null; startOvers: number; kept: Kept | null }
const byLookup = new Map<string, Fill>();
// Fills ended per sheet and column, counted on the sheets a base looks in.
const ended = new Map<string, Map<string, number>>();

const writesOne = (table: RunTable, r: RunRow, reads: string[]): string | undefined => {
  const written = new Set<string>();
  if (table === 'ai_runs') addAiRunColumns(r, written);
  else addHttpRunColumns(r, written);
  return reads.find(c => written.has(c));
};

function baseOf(rec: Rec, reads: string[]): Base {
  const other = rec.other_sheet_id, user = rec.user_id;
  if (!ended.has(other)) ended.set(other, new Map());
  const top = (t: RunTable): number => (db.prepare(`SELECT rowid FROM ${t} WHERE sheet_id = ? AND +user_id = ?
    ORDER BY rowid DESC LIMIT 1`).pluck().get(other, user) as number | undefined) ?? 0;
  const paused = new Map<string, { gen: number; column: string }>();
  for (const t of TABLES) {
    for (const r of RUNS[t].paused().all(other, user) as RunRow[]) {
      const column = writesOne(t, r, reads);
      if (column) paused.set(r.id, { gen: r.gen, column });
    }
  }
  const rowGen = db.prepare('SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?').pluck().get(other, user);
  return {
    other, reads, fills: new Map(ended.get(other)), rowGen: rowGen as number, paused,
    tops: { ai_runs: top('ai_runs'), http_runs: top('http_runs') },
  };
}

// A run there since the base writing a column it reads: a new one, or a paused one that went on.
function runSince(rec: Rec, reads: string[], was: Base): string | undefined {
  for (const t of TABLES) {
    // A new row lands above the sheet's newest run at the base, which stays while the sheet does.
    for (const r of RUNS[t].above().all(rec.other_sheet_id, rec.user_id, was.tops[t]) as RunRow[]) {
      const column = writesOne(t, r, reads);
      if (column) return column;
    }
  }
  if (was.paused.size === 0) return undefined;
  // Only a resume takes a run on from paused, and it moves the run's worker_generation. A cancel ends it:
  // its clear puts the ⏳ cells (read as empty while it was paused) back to what they held before it.
  for (const t of TABLES) {
    for (const r of db.prepare(`SELECT id, worker_generation AS gen, status FROM ${t}
      WHERE id IN (SELECT value FROM json_each(?)) AND user_id = ?`)
      .all(JSON.stringify([...was.paused.keys()]), rec.user_id) as Array<RunRow & { status: string }>) {
      const p = was.paused.get(r.id)!;
      if (r.gen !== p.gen || r.status !== 'paused') return p.column;
    }
  }
  return undefined;
}

const fillOf = (rec: Pick<Rec, 'id' | 'user_id'>): Fill => byLookup.get(rec.id)
  ?? byLookup.set(rec.id, { user: rec.user_id, base: null, startOvers: 0, kept: null }).get(rec.id)!;

// At a look where nothing it reads is filling: what changed since its last look, when it has rows written.
export function readsChangedUnseen(rec: Rec, reads: string[]): LookupChange | null {
  const f = fillOf(rec), was = f.base;
  f.base = baseOf(rec, reads);
  if (rec.fill_cursor === 0) return null;
  if (!was || was.other !== rec.other_sheet_id) return { unknown: true };
  // A column it read isn't there under that name any more: its fill ends were counted under it, and a list
  // of every column lists other keys now.
  const gone = was.reads.find(c => !reads.includes(c));
  if (gone) return { column: gone };
  const column = reads.find(c => (f.base!.fills.get(c) ?? 0) !== (was.fills.get(c) ?? 0));
  if (column) return { column };
  if (f.base.rowGen !== was.rowGen) return { rows: true };
  const run = runSince(rec, reads, was);
  return run ? { column: run } : null;
}

// Its rows written so far go: it looks every row up again from the first (the cursor is the record's,
// so a restart does too). True when they did.
export function startOver(rec: Pick<LookupColumnRow, 'id' | 'user_id'>): boolean {
  return db.prepare(`UPDATE lookup_columns SET fill_cursor = 0, filled_rows = 0, error_rows = 0, first_error = NULL,
      updated_at = datetime('now')
    WHERE id = ? AND user_id = ? AND fill_status = 'filling' AND fill_cursor > 0`).run(rec.id, rec.user_id).changes > 0;
}

// What changed while it had rows written: it starts over (true), unless it already did
// LOOKUP_FILL_START_OVERS times this fill for a change; then it goes on where it was and says so.
export function startOverFor(rec: Rec, change: LookupChange): boolean {
  if (rec.fill_cursor === 0) return false;
  const f = fillOf(rec);
  if ('unknown' in change) return startOver(rec);
  if (f.startOvers >= LOOKUP_FILL_START_OVERS) {
    f.kept = { other: rec.other_sheet_id, column: 'column' in change ? change.column : null };
    return false;
  }
  if (!startOver(rec)) return false;
  f.startOvers++;
  return true;
}

// Rows it went on with, past its start overs, may hold older values (null: none), in the names of now.
export function keptChangingNote(rec: Pick<LookupColumnRow, 'id' | 'user_id'>): string | null {
  const kept = byLookup.get(rec.id)?.kept;
  if (!kept) return null;
  const sheet = (db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ?').pluck()
    .get(kept.other, rec.user_id) as string | undefined) ?? 'the other sheet';
  return (kept.column === null
    ? `The rows of "${sheet}" kept changing (sorted, replaced by an import or duplicates removed), so rows `
      + 'looked up before the last change'
    : getSheetColumns(kept.other, rec.user_id, false).includes(kept.column)
      ? `"${kept.column}" in "${sheet}" kept changing, so rows looked up before its last change`
      // Gone (deleted, or renamed before the note): its old name would name nothing there.
      : `A column of "${sheet}" it read was renamed or deleted, so rows looked up before that`)
    + ' may hold older values. Look up every row again to redo them.';
}

// A column of this user's sheet renamed (column-rename.ts, once switched): its fill ends count on under the new
// name, and a note naming it names it as it's called now.
export function columnRenamedForLookups(sheetId: string, userId: string, from: string, to: string): void {
  const fills = ended.get(sheetId), n = fills?.get(from);
  if (fills) { fills.delete(from); if (n === undefined) fills.delete(to); else fills.set(to, n); }
  for (const { user, kept } of byLookup.values()) {
    if (user === userId && kept?.other === sheetId && kept.column === from) kept.column = to;
  }
}

// It fills again from the first row (a start, "Look up every row again", a restore): no start overs, no note.
export const lookupFillStarted = (id: string): void => { byLookup.delete(id); };

// A fill of this column there ended (derived-fill-wait.ts fillEnded): counted where a base looks.
export function countFillEnd(sheetId: string, column: string): void {
  const sheet = ended.get(sheetId);
  if (sheet) sheet.set(column, (sheet.get(column) ?? 0) + 1);
  forgetEndedLookupFills();
}

// The fills that aren't going any more (ended, the lookup deleted) lose their base and start
// overs (a note stays with its lookup), and fill ends are counted only where a base still looks.
export function forgetEndedLookupFills(): void {
  if (byLookup.size > 0) {
    // Each lookup with its own user: {id: user_id}.
    const status = new Map((db.prepare(`SELECT l.id, l.fill_status FROM json_each(?) j
      JOIN lookup_columns l ON l.id = j.key AND l.user_id = j.value`)
      .all(JSON.stringify(Object.fromEntries([...byLookup].map(([id, f]) => [id, f.user])))) as
      Array<{ id: string; fill_status: string }>).map(r => [r.id, r.fill_status]));
    for (const [id, f] of byLookup) {
      if (status.get(id) === 'filling') continue;
      if (status.has(id) && f.kept) Object.assign(f, { base: null, startOvers: 0 });
      else byLookup.delete(id);
    }
  }
  const lookedIn = new Set([...byLookup.values()].map(f => f.base?.other));
  for (const sheet of ended.keys()) if (!lookedIn.has(sheet)) ended.delete(sheet);
}

// What this process keeps (for tests): the lookups with a fill's entry, the sheets counting fill ends.
export const lookupFillsKept = () => ({ lookups: [...byLookup.keys()], sheets: [...ended.keys()] });
