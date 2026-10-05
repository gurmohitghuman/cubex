// Which columns an ACTIVE AI run READS — the inputs its prompt substitutes,
// as opposed to the outputs it writes.
//
// The gap this closes: lib/prompt-ref-validate.ts rejects unknown /column refs at run
// START, preview, and rerun — but a source column renamed or deleted WHILE a run
// is in flight silently turns every subsequent row's prompt into
// "[MISSING: /old_name]". The rows already processed are fine, the rest are paid
// garbage, and nothing surfaces until a human reads the output. The structural
// guards in column-rename.ts / column-delete.ts only ever protected a run's
// OUTPUT columns (ai_runs.column_name and its (Data) sibling, HTTP master +
// mapping columns) — never its inputs.
//
// Matching MUST mirror processPromptTemplate exactly (normalized OR
// case-insensitive exact), or the guard and the substitution disagree: a guard
// that is stricter blocks harmless renames, and one that is looser lets the
// [MISSING] case through, which is the whole bug.
import { db } from './db';
import { extractColumnReferences, normalizeColumnName } from './prompt';
import { extractTemplateTokenNames } from './http-request-template';

// True when `columnName` is referenced by `prompt`'s /tokens under the same
// matching rule the substitution uses.
export function promptReferencesColumn(prompt: string, columnName: string): boolean {
  const normCol = normalizeColumnName(columnName);
  const lowerCol = columnName.toLowerCase();
  for (const ref of extractColumnReferences(prompt)) {
    if (normalizeColumnName(ref) === normCol) return true;
    if (ref.toLowerCase() === lowerCol) return true;
  }
  return false;
}

// The id of an active AI run whose PROMPT reads `columnName`, or null.
//
// Scans prompts in JS rather than SQL: /token matching is normalized
// (spaces/punctuation → underscores, case-folded), which SQL LIKE cannot
// express without reimplementing normalizeColumnName in SQL and letting the two
// drift. The candidate set is tiny — active runs on ONE sheet, bounded by
// MAX_ACTIVE_RUNS_PER_USER — so this is a handful of short strings, not a scan.
export function activeRunReadsColumn(
  sheetId: string, userId: string, columnName: string,
): string | null {
  // Only `prompt` — NOT system_prompt. ai-row.ts substitutes the user prompt
  // (processPromptTemplate) but pushes system_prompt through VERBATIM, so a
  // /token there is never a column reference and renaming that column cannot
  // produce a [MISSING]. Guarding it would block harmless renames.
  const rows = db.prepare(`
    SELECT id, prompt FROM ai_runs
    WHERE sheet_id = ? AND user_id = ? AND status IN ('pending', 'running', 'paused')
  `).all(sheetId, userId) as Array<{ id: string; prompt: string | null }>;

  for (const run of rows) {
    if (run.prompt && promptReferencesColumn(run.prompt, columnName)) return run.id;
  }
  return null;
}

// The id of an active HTTP run whose request (URL, header names and values,
// body) reads `columnName`, or null. Same reason as the AI guard: a running job
// keeps substituting its template per row, so deleting or renaming an input
// mid-run turned the remaining requests into garbage. Matching mirrors
// replaceTemplateVariables ({{name}} and /name; case-insensitive or normalized).
export function activeHttpRunReadsColumn(
  sheetId: string, userId: string, columnName: string,
): string | null {
  const rows = db.prepare(`
    SELECT id, config FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND status IN ('pending', 'running', 'paused')
  `).all(sheetId, userId) as Array<{ id: string; config: string | null }>;
  const normCol = normalizeColumnName(columnName);
  const lowerCol = columnName.toLowerCase();
  for (const run of rows) {
    let rc: { url?: unknown; headers?: unknown; body?: unknown } | undefined;
    try { rc = JSON.parse(run.config || '{}')?.requestConfig; } catch { continue; }
    if (!rc) continue;
    const parts = [rc.url, rc.body];
    if (rc.headers && typeof rc.headers === 'object') {
      for (const [k, v] of Object.entries(rc.headers as Record<string, unknown>)) parts.push(k, v);
    }
    for (const part of parts) {
      if (typeof part !== 'string') continue;
      for (const name of extractTemplateTokenNames(part)) {
        if (name.toLowerCase() === lowerCol || normalizeColumnName(name) === normCol) return run.id;
      }
    }
  }
  return null;
}

// The user-facing block message when `columnName` is an active run's input
// (an AI prompt or an HTTP request), or null when it isn't. Shared by column-rename.ts and column-delete.ts
// so both surfaces phrase the same refusal identically.
//
// Blocking, NOT silently rewriting the stored prompt: the runner re-substitutes
// that prompt per row, so a rename mid-run turns every REMAINING row into
// "[MISSING: /old_name]" and bills for the garbage. Rewriting would mutate a
// prompt the user already authorized and paid against — and would still leave
// rows processed under the old text, so the run's output would silently mix two
// prompts. Refusing matches how the existing OUTPUT-column guards behave.
export function activeRunInputError(
  sheetId: string, userId: string, columnName: string, action: 'rename' | 'delete',
): string | null {
  if (activeRunReadsColumn(sheetId, userId, columnName)) {
    return `Cannot ${action} a column while an active AI run's prompt reads it — the remaining rows `
      + `would see "[MISSING]" instead of this column's values. Stop the run first, then ${action}.`;
  }
  if (activeHttpRunReadsColumn(sheetId, userId, columnName)) {
    return `Cannot ${action} a column while an active HTTP run's request uses it — the remaining rows `
      + `would be sent without this column's values. Stop the run first, then ${action}.`;
  }
  return null;
}
