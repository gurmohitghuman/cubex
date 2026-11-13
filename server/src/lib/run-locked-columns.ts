import { db } from './db';

// Columns that an active (pending/running/paused) run on this sheet is writing
// into per-row. A manual cell edit or preview-commit to one of these would race
// the worker's json_set (ai-row.ts / http-row.ts): either the worker overwrites
// the user's edit mid-run, or the edit clobbers an in-flight result. Sort and
// bulk-delete take a sheet-WIDE active-run guard because they rewrite row_index
// (every run's write target); a cell edit only collides on the run's OWN output
// columns, so we lock just those and let autosave proceed on the rest of the sheet
// (PUT /:id/data is the single autosave persistence driver — a blanket guard would
// silently drop every edit anywhere on the sheet for the whole run duration).
//
// AI: run.column_name plus its " (Data)" sibling (web-search runs write a
//   "<col> (Data)" / "<col> (Output)"→"<col> (Data)" companion — ai-row.ts).
// HTTP: every config.responseMapping[].columnName AND master_column_name. The
//   master column is NOT just the input — the worker overwrites it per-row with a
//   status marker (✅ Success / ❌ Failed / ⏭️ Skipped, see http-cell-values.ts),
//   and run-start stamps "⏳ Processing..." into it. So it's a write target too.
//
// `paused: false` leaves paused runs out: what a reader that would otherwise
// wait for the run asks (a lookup fill), since a run can stay paused for days.
// `autorun: false` leaves auto-run's batch runs out (a lookup fill goes on
// after one, where it starts over after any other run).
// `clearing: true` adds runs that ended (cancelled or failed) and are still
// clearing their ⏳ cells (placeholder_work set, in whichever thread clears
// them): each such cell gets back what it held before the run
// (lib/run-undo/clear-back.ts), so a reader waiting for a run's values (a
// lookup fill) waits for that too.
export function getLockedRunColumns(sheetId: string, userId: string, opts: RunHoldOpts = {}): Set<string> {
  return new Set(runHeldColumns(sheetId, userId, opts).keys());
}

type RunHoldOpts = { paused?: boolean; autorun?: boolean; clearing?: boolean };
// How a run holds a column: going (pending, running or paused), or only clearing
// its ⏳ cells after it stopped or failed (when no run going holds it too).
export type RunHold = 'going' | 'clearing';

// A run that holds columns: which run, its status, how it holds them (going or clearing), and the columns.
export interface HeldBy { type: 'ai' | 'http'; id: string; status: string; hold: RunHold; columns: Set<string> }

function heldRuns(sheetId: string, userId: string, opts: RunHoldOpts): HeldBy[] {
  // The literal lists keep the partial active-run index (migration 014) usable.
  const paused = opts.paused === false ? 0 : 1;
  const active = opts.clearing
    ? "(status IN ('pending', 'running', 'paused') OR placeholder_work IS NOT NULL)"
    : "status IN ('pending','running','paused')";
  const going = "status IN ('pending','running','paused') AS going";
  type Base = { id: string; status: string; going: number };
  const runs: HeldBy[] = [];
  const add = (type: HeldBy['type'], r: Base, write: (cols: Set<string>) => void) => {
    const columns = new Set<string>();
    write(columns);
    runs.push({ type, id: r.id, status: r.status, hold: r.going ? 'going' : 'clearing', columns });
  };

  const aiRuns = db.prepare(`
    SELECT id, status, column_name, output_columns, data_column, ${going} FROM ai_runs
    WHERE sheet_id = ? AND user_id = ? AND ${active} AND (? = 1 OR status <> 'paused')
  `).all(sheetId, userId, paused) as Array<AiRunWrites & Base>;
  for (const r of aiRuns) add('ai', r, cols => addAiRunColumns(r, cols));

  const httpRuns = db.prepare(`
    SELECT id, status, config, master_column_name, ${going} FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND ${active} AND (? = 1 OR status <> 'paused')
      AND (? = 1 OR autorun_id IS NULL)
  `).all(sheetId, userId, paused, opts.autorun === false ? 0 : 1) as Array<HttpRunWrites & Base>;
  for (const r of httpRuns) add('http', r, cols => addHttpRunColumns(r, cols));
  return runs;
}

// The same columns, each with how it is held, from the same two queries.
export function runHeldColumns(sheetId: string, userId: string, opts: RunHoldOpts = {}): Map<string, RunHold> {
  const held = new Map<string, RunHold>();
  for (const r of heldRuns(sheetId, userId, opts)) {
    for (const c of r.columns) if (r.hold === 'going' || !held.has(c)) held.set(c, r.hold);
  }
  return held;
}

// The run that holds one column (lib/run-waiting.ts names it): one going before one that is clearing.
export function columnHolder(sheetId: string, userId: string, column: string, opts: RunHoldOpts = {})
  : HeldBy | null {
  const runs = heldRuns(sheetId, userId, opts).filter(r => r.columns.has(column));
  return runs.find(r => r.hold === 'going') ?? runs[0] ?? null;
}

export type AiRunWrites = { column_name: string; output_columns: string | null; data_column: string | null };
export type HttpRunWrites = { config: string | null; master_column_name: string | null };

// The columns an AI run writes.
export function addAiRunColumns(r: AiRunWrites, locked: Set<string>): void {
  // column_name is the (Output) column (single-column) OR the status column
  // (structured runs). Lock it either way.
  locked.add(r.column_name);
  if (r.output_columns) {
    // Structured run: lock EVERY typed output column too — an edit to any of
    // them mid-run would be clobbered by (or clobber) the runner's write.
    try {
      for (const s of JSON.parse(r.output_columns) as Array<{ columnName?: unknown }>) {
        if (s && typeof s.columnName === 'string') locked.add(s.columnName);
      }
    } catch { /* malformed spec — the status column lock still holds */ }
    // ...and its "(Data)" sources column when it uses a web tool (migration 006).
    if (r.data_column) locked.add(r.data_column);
  } else {
    // Single-column: lock the (Data) sibling unconditionally — cheap, and
    // simpler than working out whether this run writes one.
    const dataCol = r.column_name.endsWith(' (Output)')
      ? r.column_name.replace(/ \(Output\)$/, ' (Data)')
      : `${r.column_name} (Data)`;
    locked.add(dataCol);
  }
}

// The columns an HTTP run writes.
export function addHttpRunColumns(r: HttpRunWrites, locked: Set<string>): void {
  if (r.master_column_name) locked.add(r.master_column_name);
  if (!r.config) return;
  try {
    const cfg = JSON.parse(r.config) as { responseMapping?: Array<{ columnName?: unknown }> };
    for (const m of cfg.responseMapping ?? []) {
      if (typeof m.columnName === 'string') locked.add(m.columnName);
    }
  } catch {
    // Malformed config JSON shouldn't crash the edit path. A run with an
    // unparseable config can't be writing meaningful columns anyway.
  }
}
