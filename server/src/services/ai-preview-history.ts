// What preview rows measured, kept for estimate_only (ai_preview_tokens,
// migration 055): a preview of a prompt is the best guess of what a run of it
// will cost until a run has finished rows (services/ai-token-history.ts).
// Written by run_ai_column's preview_rows (run-preview.ts) and the app's
// preview (routes/ai-preview.ts). Bounded three ways: a new preview of the same
// prompt and model on a sheet replaces the one before it there, each user keeps
// the newest AI_PREVIEW_HISTORY_MAX_ROWS rows, and rows go with their sheet.
import { db } from '../lib/db';
import { AI_PREVIEW_HISTORY_MAX_ROWS, AI_ESTIMATE_HISTORY_ROWS_PER_RUN } from '../lib/constants-ai';
import { promptHash } from '../lib/ai-prompt-hash';
import { redactError } from '../lib/redact';
import type { RowTokens } from '../lib/responses-adapter';

export interface PreviewSetup {
  model: string; prompt: string; webSearch: boolean; webFetch: boolean; engineUsed: string | null;
}

// Rows that answered (no error) and reported their tokens. Never throws: a
// preview the user paid for answers even when this record can't be written.
export function savePreviewTokens(
  userId: string, sheetId: string, s: PreviewSetup, rows: Array<{ error?: string; tokens?: RowTokens }>,
): void {
  const kept = rows.filter(r => !r.error && r.tokens && (r.tokens.input !== null || r.tokens.output !== null));
  if (kept.length === 0) return;
  const hash = promptHash(s.prompt);
  try {
    db.transaction(() => {
      db.prepare(`DELETE FROM ai_preview_tokens WHERE user_id = ? AND model = ? AND prompt_hash = ? AND sheet_id = ?`)
        .run(userId, s.model, hash, sheetId);
      const insert = db.prepare(`INSERT INTO ai_preview_tokens (user_id, sheet_id, model, prompt_hash, web_search,
        web_fetch, web_search_engine_used, prompt_tokens, completion_tokens, reasoning_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const r of kept) {
        insert.run(userId, sheetId, s.model, hash, s.webSearch ? 1 : 0, s.webFetch ? 1 : 0,
          s.webSearch ? s.engineUsed : null, r.tokens!.input, r.tokens!.output, r.tokens!.reasoning);
      }
      // The user's rows past the newest MAX: one index walk of at most MAX entries.
      db.prepare(`DELETE FROM ai_preview_tokens WHERE user_id = ? AND id <= (
        SELECT id FROM ai_preview_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`)
        .run(userId, userId, AI_PREVIEW_HISTORY_MAX_ROWS);
    }).immediate();
  } catch (error) {
    console.error('Keeping what a preview measured failed:', redactError(error));
  }
}

// The newest preview rows of this prompt on this model (any sheet), at most
// ROWS_PER_RUN; with web tools, only rows that ran with the same tools (and
// the same search engine, when given).
export function previewTokenRows(
  userId: string, model: string, prompt: string, web?: { search: boolean; fetch: boolean; engine: string | null },
): Array<{ p: number | null; c: number | null }> {
  const hash = promptHash(prompt);
  if (!web) {
    return db.prepare(`SELECT prompt_tokens AS p, completion_tokens AS c FROM ai_preview_tokens
      WHERE user_id = ? AND model = ? AND prompt_hash = ? ORDER BY id DESC LIMIT ?`)
      .all(userId, model, hash, AI_ESTIMATE_HISTORY_ROWS_PER_RUN) as Array<{ p: number | null; c: number | null }>;
  }
  return db.prepare(`SELECT prompt_tokens AS p, completion_tokens AS c FROM ai_preview_tokens
    WHERE user_id = ? AND model = ? AND prompt_hash = ? AND web_search = ? AND web_fetch = ?
      AND (? IS NULL OR web_search_engine_used = ?)
    ORDER BY id DESC LIMIT ?`)
    .all(userId, model, hash, web.search ? 1 : 0, web.fetch ? 1 : 0, web.engine, web.engine,
      AI_ESTIMATE_HISTORY_ROWS_PER_RUN) as Array<{ p: number | null; c: number | null }>;
}
