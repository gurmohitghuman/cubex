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
export function getLockedRunColumns(sheetId: string, userId: string): Set<string> {
  const locked = new Set<string>();

  const aiRuns = db.prepare(`
    SELECT column_name, output_columns FROM ai_runs
    WHERE sheet_id = ? AND user_id = ? AND status IN ('pending','running','paused')
  `).all(sheetId, userId) as Array<{ column_name: string; output_columns: string | null }>;
  for (const r of aiRuns) {
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
    } else {
      // Single-column: lock the (Data) sibling unconditionally — cheap, and
      // simpler than working out whether this run writes one.
      const dataCol = r.column_name.endsWith(' (Output)')
        ? r.column_name.replace(/ \(Output\)$/, ' (Data)')
        : `${r.column_name} (Data)`;
      locked.add(dataCol);
    }
  }

  const httpRuns = db.prepare(`
    SELECT config, master_column_name FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND status IN ('pending','running','paused')
  `).all(sheetId, userId) as Array<{ config: string | null; master_column_name: string | null }>;
  for (const r of httpRuns) {
    if (r.master_column_name) locked.add(r.master_column_name);
    if (!r.config) continue;
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

  return locked;
}
