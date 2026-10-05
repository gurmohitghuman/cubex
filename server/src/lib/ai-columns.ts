import { db } from './db';
import { renamePromptColumnRefs } from './column-ref-rename';
import { computeConfigHash, type DraftConfig } from './ai-drafts';

// Structured-AI-run ↔ column lifecycle cascade — the AI twin of lib/http-columns.ts,
// for the parts single-column rename/delete already handle via ai_runs.column_name
// but that a structured run also stores elsewhere: the status_column field and the
// output_columns JSON ([{columnName,type,description}]). column_name (= the status
// column for structured runs) is kept in sync by column-rename/column-delete
// already; these helpers cover the extra state so getColumnTypes, getLockedRunColumns,
// and placeholder-clearing never reference a renamed/deleted column. Call INSIDE the
// rename/delete transaction. Strict (case-sensitive) equality — the routes already
// reject case-insensitive duplicates.

// Rewrite output_columns[].columnName in JS — only the runs whose spec actually
// references oldName get re-serialized.
function rewriteOutputColumns(
  sheetId: string, userId: string, mutate: (specs: Array<{ columnName?: unknown }>) => boolean,
): void {
  const runs = db.prepare(
    `SELECT id, output_columns FROM ai_runs WHERE sheet_id = ? AND user_id = ? AND output_columns IS NOT NULL`,
  ).all(sheetId, userId) as Array<{ id: string; output_columns: string }>;
  const update = db.prepare(`UPDATE ai_runs SET output_columns = ? WHERE id = ?`);
  for (const run of runs) {
    let specs: Array<{ columnName?: unknown }>;
    try { specs = JSON.parse(run.output_columns); } catch { continue; }
    if (!Array.isArray(specs)) continue;
    if (mutate(specs)) update.run(JSON.stringify(specs), run.id);
  }
}

// On column RENAME: keep every ai_runs reference to the column in sync.
//   - column_name: the "(Output)" name (single-column) or the STATUS column
//     (structured). getColumnTypes reads ALL ai_runs regardless of status to
//     classify columns, and a rerun looks up its run by this name; without the
//     update a NEW plain column reusing the OLD name is misclassified as AI
//     output and a stale-prompt rerun overwrites it.
//   - status_column field + output_columns[].columnName: structured-run state.
//   - The web-search "(Data)" companion: renaming it detaches it from the run
//     (clear use_openrouter_web_search on the sibling "(Output)" run) so the old
//     (Data) name isn't still classified ai-data.
export function renameAiRunColumnRefs(
  sheetId: string, userId: string, oldName: string, newName: string,
): void {
  db.prepare(
    `UPDATE ai_runs SET column_name = ? WHERE sheet_id = ? AND user_id = ? AND column_name = ?`,
  ).run(newName, sheetId, userId, oldName);
  db.prepare(
    `UPDATE ai_runs SET status_column = ? WHERE sheet_id = ? AND user_id = ? AND status_column = ?`,
  ).run(newName, sheetId, userId, oldName);
  if (oldName.endsWith(' (Data)')) {
    const outputName = `${oldName.slice(0, -' (Data)'.length)} (Output)`;
    db.prepare(
      `UPDATE ai_runs SET use_openrouter_web_search = 0 WHERE sheet_id = ? AND user_id = ? AND column_name = ?`,
    ).run(sheetId, userId, outputName);
  }

  rewriteOutputColumns(sheetId, userId, specs => {
    let changed = false;
    for (const s of specs) if (s && s.columnName === oldName) { s.columnName = newName; changed = true; }
    return changed;
  });

  // Prompts that read the column (/token) follow the rename, or a re-run would
  // reject them as referencing an unknown column.
  const runs = db.prepare('SELECT id, prompt FROM ai_runs WHERE sheet_id = ? AND user_id = ?')
    .all(sheetId, userId) as Array<{ id: string; prompt: string }>;
  const setPrompt = db.prepare('UPDATE ai_runs SET prompt = ? WHERE id = ?');
  for (const r of runs) {
    const prompt = renamePromptColumnRefs(r.prompt, oldName, newName);
    if (prompt !== r.prompt) setPrompt.run(prompt, r.id);
  }
  // And the sheet's saved AI-panel draft, so reopening the panel restores a
  // prompt that still runs. Its previews stay reusable: the rewritten prompt
  // interpolates to the same text from the renamed cells.
  const drafts = db.prepare('SELECT id, config_json FROM ai_column_drafts WHERE sheet_id = ? AND user_id = ?')
    .all(sheetId, userId) as Array<{ id: string; config_json: string }>;
  const setDraft = db.prepare('UPDATE ai_column_drafts SET config_json = ?, config_hash = ? WHERE id = ?');
  for (const d of drafts) {
    let config: DraftConfig;
    try { config = JSON.parse(d.config_json); } catch { continue; }
    if (typeof config?.prompt !== 'string') continue;
    const prompt = renamePromptColumnRefs(config.prompt, oldName, newName);
    if (prompt === config.prompt) continue;
    config.prompt = prompt;
    setDraft.run(JSON.stringify(config), computeConfigHash(config), d.id);
  }
}

// On column DELETE: disassociate every ai_runs reference to the deleted column.
//   - column_name: NOT NULL, so we can't null it — tombstone with a LEADING
//     SPACE prefix. sanitizeColumnName trims whitespace at every column-creation
//     site, so no live column can begin with a space and the tombstone can never
//     collide. Effect: getColumnTypes no longer matches a NEW plain column
//     reusing the name, and a rerun by the old base name 404s instead of
//     resurrecting stale-prompt data. Historical run rows stay for the audit trail.
//   - The web-search "(Data)" companion: clear the sibling run's flag so a new
//     "X (Data)" reusing the name isn't misclassified.
//   - status_column field NULLed + output_columns entry pruned (structured runs).
// Delete is blocked while a run targeting the column is active, so this only ever
// rewrites terminal runs.
export function deleteAiRunColumnRefs(
  sheetId: string, userId: string, columnName: string,
): void {
  db.prepare(
    `UPDATE ai_runs SET column_name = ? WHERE sheet_id = ? AND user_id = ? AND column_name = ?`,
  ).run(` deleted:${columnName}`, sheetId, userId, columnName);
  if (columnName.endsWith(' (Data)')) {
    const outputName = `${columnName.slice(0, -' (Data)'.length)} (Output)`;
    db.prepare(
      `UPDATE ai_runs SET use_openrouter_web_search = 0 WHERE sheet_id = ? AND user_id = ? AND column_name = ?`,
    ).run(sheetId, userId, outputName);
  }
  db.prepare(
    `UPDATE ai_runs SET status_column = NULL WHERE sheet_id = ? AND user_id = ? AND status_column = ?`,
  ).run(sheetId, userId, columnName);

  rewriteOutputColumns(sheetId, userId, specs => {
    const before = specs.length;
    for (let i = specs.length - 1; i >= 0; i--) if (specs[i] && specs[i].columnName === columnName) specs.splice(i, 1);
    return specs.length !== before;
  });
}

// Column names an active structured run writes (its output columns). Used by the
// delete guard: single-column delete blocks on ai_runs.column_name, but a
// structured run's OUTPUT columns live in output_columns, not column_name. A
// stopped run still clearing its ⏳ cells (migration 004) counts: a rename
// would copy them to a name the clear never visits.
export function activeStructuredRunOwnsColumn(
  sheetId: string, userId: string, columnName: string,
): boolean {
  const runs = db.prepare(
    `SELECT output_columns FROM ai_runs
       WHERE sheet_id = ? AND user_id = ? AND output_columns IS NOT NULL
         AND (status IN ('pending','running','paused') OR placeholder_work IS NOT NULL)`,
  ).all(sheetId, userId) as Array<{ output_columns: string }>;
  for (const r of runs) {
    try {
      for (const s of JSON.parse(r.output_columns) as Array<{ columnName?: unknown }>) {
        if (s && s.columnName === columnName) return true;
      }
    } catch { /* malformed — ignore */ }
  }
  return false;
}
