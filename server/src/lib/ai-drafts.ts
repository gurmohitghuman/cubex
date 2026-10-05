import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from './db';
import { processPromptTemplate } from './prompt';
import { AI_DRAFT_MAX_PREVIEW_BYTES } from './constants';

// AI Column draft persistence (ai_column_drafts, migration 030) — the modal's
// config + last COMPLETE preview, one row per (user, sheet). Written by
// /ai/preview (config at stream start, results all-or-nothing at stream end),
// read by GET /ai/drafts/:sheetId (modal hydration) and by run-start promotion
// (lib/ai-run-promote.ts — credit reuse). Deliberately separate from ai_runs:
// this is MODAL state, not run state.

// The config a draft round-trips. columnName is the CLEANED name
// (sanitizeAndValidateColumnName output) so preview-time and run-time
// comparisons are canonical-to-canonical.
export interface DraftConfig {
  columnName: string;
  prompt: string;
  systemPrompt: string | null;
  model: string;
  temperature: number;
  useOpenRouterWebSearch: boolean;
  useWebFetch: boolean;
  maxChars: number | null;
  // Restored on hydration but EXCLUDED from the config hash — concurrency
  // changes scheduling, never a row's output, so it must not invalidate reuse.
  concurrency: number;
}

export interface DraftPreviewRow {
  rowIndex: number;
  value: string;
  error?: string;
  // sha256 of the interpolated prompt this row's preview was generated from.
  // Absent on errored rows (they're never reusable).
  inputHash?: string;
  promptTokens?: number;
  completionTokens?: number;
}

export interface AIDraft {
  config: DraftConfig;
  configHash: string;
  rowGeneration: number | null;
  runTargetRows: number | null;
  previewResults: DraftPreviewRow[] | null;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

// Stable-order array (NOT object spread — key order must never drift between
// the preview-time and run-time computations).
export function computeConfigHash(c: DraftConfig): string {
  // Both runners IGNORE the caller's systemPrompt when a web tool is on (they
  // substitute a fixed tool system prompt — ai-preview-runner.ts / ai-row.ts),
  // so hashing it there would fail reuse over a field that can't change the
  // output. Normalize it to null for tool runs; hash the real value otherwise.
  const usingTools = !!c.useOpenRouterWebSearch || !!c.useWebFetch;
  return sha256(JSON.stringify([
    c.columnName, c.prompt, usingTools ? null : (c.systemPrompt ?? null),
    c.model, c.temperature,
    !!c.useOpenRouterWebSearch, !!c.useWebFetch, c.maxChars ?? null,
  ]));
}

// Hash the INTERPOLATED prompt: it embeds exactly the referenced cells' values,
// so an edit to a referenced cell (and only a referenced cell) changes the hash.
// Uses the same processPromptTemplate as both runners — no drift.
export function computeInputHash(prompt: string, rowData: Record<string, string>): string {
  return sha256(processPromptTemplate(prompt, rowData));
}

interface DraftDbRow {
  config_json: string;
  config_hash: string;
  row_generation: number | null;
  run_target_rows: number | null;
  preview_results_json: string | null;
}

export function getDraft(userId: string, sheetId: string): AIDraft | null {
  const row = db.prepare(
    'SELECT config_json, config_hash, row_generation, run_target_rows, preview_results_json FROM ai_column_drafts WHERE user_id = ? AND sheet_id = ?',
  ).get(userId, sheetId) as DraftDbRow | undefined;
  if (!row) return null;
  try {
    return {
      config: JSON.parse(row.config_json) as DraftConfig,
      configHash: row.config_hash,
      rowGeneration: row.row_generation,
      runTargetRows: row.run_target_rows,
      previewResults: row.preview_results_json
        ? (JSON.parse(row.preview_results_json) as DraftPreviewRow[])
        : null,
    };
  } catch {
    // Corrupt JSON (hand-edited DB) — treat as no draft rather than crashing
    // every modal open; the next preview overwrites it.
    return null;
  }
}

// Called at preview stream START: the config part of the draft persists even if
// the stream is aborted mid-way (close/disconnect). Previous preview results are
// cleared — result persistence is all-or-nothing on stream COMPLETION, so a
// half-streamed preview can never be hydrated or reused.
//
// Returns the ATTEMPT id: the row's id is regenerated on every upsert, so each
// preview stream holds a token only its own upsert produced. saveDraftPreview
// keys on it — a config_hash guard alone let an OLDER same-config stream that
// finished LAST overwrite a newer stream's results (draft would then hold
// values the user never saw).
export function upsertDraftConfig(
  userId: string, sheetId: string, config: DraftConfig, rowGeneration: number,
): string {
  const attemptId = uuidv4();
  db.prepare(`
    INSERT INTO ai_column_drafts (id, user_id, sheet_id, config_json, config_hash, row_generation)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, sheet_id) DO UPDATE SET
      id = excluded.id,
      config_json = excluded.config_json,
      config_hash = excluded.config_hash,
      row_generation = excluded.row_generation,
      preview_results_json = NULL,
      run_target_rows = NULL,
      updated_at = datetime('now')
  `).run(attemptId, userId, sheetId, JSON.stringify(config), computeConfigHash(config), rowGeneration);
  return attemptId;
}

// Called once at preview stream END (only when every row completed). The
// attempt-id guard makes a superseded stream a no-op: any later preview
// re-upserted the row with a NEW id, so this UPDATE matches nothing — even
// when the configs (and so config_hash) are identical.
export function saveDraftPreview(
  userId: string, sheetId: string, attemptId: string,
  rows: DraftPreviewRow[], runTargetRows: number,
): void {
  const json = JSON.stringify(rows);
  // Over the cap: keep the config draft, skip the results. NEVER truncate — a
  // truncated value promoted into a cell would silently pass as complete.
  if (Buffer.byteLength(json, 'utf8') > AI_DRAFT_MAX_PREVIEW_BYTES) return;
  db.prepare(`
    UPDATE ai_column_drafts
    SET preview_results_json = ?, run_target_rows = ?, updated_at = datetime('now')
    WHERE user_id = ? AND sheet_id = ? AND id = ?
  `).run(json, runTargetRows, userId, sheetId, attemptId);
}

export function deleteDraft(userId: string, sheetId: string): void {
  db.prepare('DELETE FROM ai_column_drafts WHERE user_id = ? AND sheet_id = ?').run(userId, sheetId);
}

// Consume the draft when a run starts for ITS column (owner decision: after
// "Run All Rows" the preview data is deleted — real values live in the rows).
// A draft for a DIFFERENT column survives: it's unrelated saved work.
export function deleteDraftForColumn(userId: string, sheetId: string, cleanColumnName: string): void {
  db.prepare(`
    DELETE FROM ai_column_drafts
    WHERE user_id = ? AND sheet_id = ? AND json_extract(config_json, '$.columnName') = ?
  `).run(userId, sheetId, cleanColumnName);
}
