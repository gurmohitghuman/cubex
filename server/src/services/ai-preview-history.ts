// What preview rows measured, kept for estimate_only (ai_previews and
// ai_preview_tokens, migration 055): a preview of a prompt is the best guess of
// what a run of it will cost until a run has finished rows
// (services/ai-token-history.ts). Written by run_ai_column's preview_rows
// (run-preview.ts) and the app's preview (routes/ai-preview.ts). Bounded three
// ways: a new preview of the same prompt and model on a sheet replaces the one
// before it there, each user keeps the newest AI_PREVIEW_HISTORY_MAX_ROWS rows,
// and previews go with their sheet. A column rename rewrites a preview's prompt
// and hash as it does a run's (renamePreviewPrompts).
import { db } from '../lib/db';
import { AI_PREVIEW_HISTORY_MAX_ROWS, AI_ESTIMATE_HISTORY_ROWS_PER_RUN } from '../lib/constants-ai';
import { promptHash } from '../lib/ai-prompt-hash';
import { renamePromptColumnRefs } from '../lib/column-ref-rename';
import { redactError } from '../lib/redact';
import type { RowTokens } from '../lib/responses-adapter';
import type { FetchLimits } from '../lib/web-fetch-options';
import type { WebMatch } from './ai-token-history-steps';

export interface PreviewSetup {
  model: string; prompt: string; systemPrompt?: string | null; outputs?: number;
  webSearch: boolean; webFetch: boolean; engineUsed: string | null; fetchLimits?: FetchLimits | null;
}

// Rows that answered (no error) and reported their tokens. Never throws: a
// preview the user paid for answers even when this record can't be written.
export function savePreviewTokens(
  userId: string, sheetId: string, s: PreviewSetup, rows: Array<{ error?: string; tokens?: RowTokens }>,
): void {
  const kept = rows.filter(r => !r.error && r.tokens && (r.tokens.input !== null || r.tokens.output !== null));
  if (kept.length === 0) return;
  const outputs = s.outputs ?? 0;
  const hash = promptHash(s.prompt, s.systemPrompt, outputs);
  const limits = s.webFetch ? s.fetchLimits : null;
  try {
    db.transaction(() => {
      db.prepare(`DELETE FROM ai_previews WHERE user_id = ? AND model = ? AND prompt_hash = ? AND sheet_id = ?`)
        .run(userId, s.model, hash, sheetId);
      const preview = db.prepare(`INSERT INTO ai_previews (user_id, sheet_id, model, prompt, system_prompt,
        output_count, prompt_hash, web_search, web_fetch, web_search_engine_used, web_fetch_max_content_tokens,
        web_fetch_max_pages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, sheetId, s.model, s.prompt,
        s.systemPrompt || null, outputs, hash, s.webSearch ? 1 : 0, s.webFetch ? 1 : 0,
        s.webSearch ? s.engineUsed : null, limits?.maxContentTokens ?? null, limits?.maxPagesPerRow ?? null)
        .lastInsertRowid;
      const insert = db.prepare(`INSERT INTO ai_preview_tokens (preview_id, user_id, prompt_tokens,
        completion_tokens, reasoning_tokens) VALUES (?, ?, ?, ?, ?)`);
      for (const r of kept) insert.run(preview, userId, r.tokens!.input, r.tokens!.output, r.tokens!.reasoning);
      // The user's rows past the newest MAX: one index walk of at most MAX entries; then the previews left empty.
      const cut = db.prepare(`DELETE FROM ai_preview_tokens WHERE user_id = ? AND id <= (
        SELECT id FROM ai_preview_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`)
        .run(userId, userId, AI_PREVIEW_HISTORY_MAX_ROWS);
      if (cut.changes > 0) {
        db.prepare(`DELETE FROM ai_previews WHERE user_id = ?
          AND NOT EXISTS (SELECT 1 FROM ai_preview_tokens WHERE preview_id = ai_previews.id)`).run(userId);
      }
    }).immediate();
  } catch (error) {
    console.error('Keeping what a preview measured failed:', redactError(error));
  }
}

type Row = { p: number | null; c: number | null };

// The newest preview rows of this prompt (its hash: lib/ai-prompt-hash.ts) on
// this model (any sheet), at most ROWS_PER_RUN; with web tools, only rows that
// ran with the same tools and fetch limits (and the same search engine, when given).
export function previewTokenRows(userId: string, model: string, hash: string, web?: WebMatch): Row[] {
  if (!web) {
    return db.prepare(`SELECT t.prompt_tokens AS p, t.completion_tokens AS c
      FROM ai_previews v JOIN ai_preview_tokens t ON t.preview_id = v.id
      WHERE v.user_id = ? AND v.model = ? AND v.prompt_hash = ?
      ORDER BY t.id DESC LIMIT ?`).all(userId, model, hash, AI_ESTIMATE_HISTORY_ROWS_PER_RUN) as Row[];
  }
  return db.prepare(`SELECT t.prompt_tokens AS p, t.completion_tokens AS c
    FROM ai_previews v JOIN ai_preview_tokens t ON t.preview_id = v.id
    WHERE v.user_id = ? AND v.model = ? AND v.prompt_hash = ? AND v.web_search = ? AND v.web_fetch = ?
      AND (? IS NULL OR v.web_search_engine_used = ?)
      AND v.web_fetch_max_content_tokens IS ? AND v.web_fetch_max_pages IS ?
    ORDER BY t.id DESC LIMIT ?`)
    .all(userId, model, hash, web.search ? 1 : 0, web.fetch ? 1 : 0, web.engine, web.engine, web.maxContentTokens,
      web.maxPages, AI_ESTIMATE_HISTORY_ROWS_PER_RUN) as Row[];
}

// On a column rename (lib/ai-columns.ts, inside its transaction): the sheet's
// previews whose prompt reads the column follow it, hash included, so an
// estimate of the rewritten prompt still finds them.
export function renamePreviewPrompts(sheetId: string, userId: string, oldName: string, newName: string): void {
  const previews = db.prepare(`SELECT id, prompt, system_prompt, output_count FROM ai_previews
    WHERE sheet_id = ? AND user_id = ?`).all(sheetId, userId) as Array<{
      id: number; prompt: string; system_prompt: string | null; output_count: number }>;
  const set = db.prepare('UPDATE ai_previews SET prompt = ?, prompt_hash = ? WHERE id = ?');
  for (const v of previews) {
    const prompt = renamePromptColumnRefs(v.prompt, oldName, newName);
    if (prompt !== v.prompt) set.run(prompt, promptHash(prompt, v.system_prompt, v.output_count), v.id);
  }
}
