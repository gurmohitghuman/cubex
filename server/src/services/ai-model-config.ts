// Default-AI-model configuration — extracted from routes/settings-default-model.ts
// and the sheets-crud default-model route so the UI routes and the MCP
// set_default_model tool share one implementation. Resolution order lives in
// lib/ai-model-resolve.ts: explicit pick > sheet default > account default,
// and NO hardcoded fallback — clearing both means AI runs are rejected until
// a model is chosen again.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { validateModelParam } from '../lib/ai-model-resolve';

export type ModelConfigOutcome =
  | { ok: { model: string | null } }
  | { fail: 'bad_request' | 'not_found'; message: string };

// Normalize a client-supplied model value: trimmed id, or null to clear.
function normalizeModel(model: unknown): { value: string | null } | { error: string } {
  if (model !== null && model !== undefined) {
    const err = validateModelParam(model);
    if (err) return { error: err };
  }
  return { value: typeof model === 'string' && model.trim() ? model.trim() : null };
}

// Account-level default (settings.default_ai_model, migration 032). Upsert:
// registration creates the settings row, but accounts predating that (or rows
// cleared by support tooling) may not have one.
export function setAccountDefaultModel(userId: string, model: unknown): ModelConfigOutcome {
  const n = normalizeModel(model);
  if ('error' in n) return { fail: 'bad_request', message: n.error };

  const existing = db.prepare('SELECT id FROM settings WHERE user_id = ?')
    .get(userId) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      "UPDATE settings SET default_ai_model = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
    ).run(n.value, existing.id, userId);
  } else {
    db.prepare('INSERT INTO settings (id, user_id, default_ai_model) VALUES (?, ?, ?)')
      .run(uuidv4(), userId, n.value);
  }
  return { ok: { model: n.value } };
}

// Sheet-level default (sheets.default_ai_model) — overrides the account
// default for runs on that sheet.
export function setSheetDefaultModel(userId: string, sheetId: string, model: unknown): ModelConfigOutcome {
  const n = normalizeModel(model);
  if ('error' in n) return { fail: 'bad_request', message: n.error };

  const result = db.prepare(
    "UPDATE sheets SET default_ai_model = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
  ).run(n.value, sheetId, userId);
  if (result.changes === 0) return { fail: 'not_found', message: 'Sheet not found' };
  return { ok: { model: n.value } };
}
