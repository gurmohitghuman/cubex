// Default-AI-model configuration — extracted from routes/settings-default-model.ts
// and the sheets-crud default-model route so the UI routes and the MCP
// set_default_model tool share one implementation. Resolution order lives in
// lib/ai-model-resolve.ts: explicit pick > sheet default > account default,
// and NO hardcoded fallback — clearing both means AI runs are rejected until
// a model is chosen again.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { validateModelParam } from '../lib/ai-model-resolve';
import { logSheetChange } from '../lib/change-log';
import { batchOnlyRefusal, checkModel, modelGoneMessage } from '../lib/ai-model-check';
import { verifySheetOwnership } from '../lib/sql-helpers';

// checked: false when a model was saved without OpenRouter's list to check it
// against (unreachable); a cleared default is always true. gone: the model
// isn't on the list.
export type ModelConfigOutcome =
  | { ok: { model: string | null; checked: boolean } }
  | { fail: 'bad_request' | 'not_found'; message: string; gone?: true };

// A model the list doesn't have is refused: a default is sticky, and every
// later run on it would be refused at its start. So is a ":batch" variant, list or no list.
async function checkDefault(model: string | null): Promise<{ checked: boolean } | { fail: ModelConfigOutcome }> {
  if (model === null) return { checked: true };
  const batch = batchOnlyRefusal(model);
  if (batch) return { fail: { fail: 'bad_request', message: batch } };
  const check = await checkModel(model);
  if (check === 'gone') {
    return { fail: { fail: 'bad_request', message: `${modelGoneMessage(model)} Choose another model.`, gone: true } };
  }
  return { checked: check === 'listed' };
}

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
export async function setAccountDefaultModel(userId: string, model: unknown): Promise<ModelConfigOutcome> {
  const n = normalizeModel(model);
  if ('error' in n) return { fail: 'bad_request', message: n.error };
  const check = await checkDefault(n.value);
  if ('fail' in check) return check.fail;

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
  return { ok: { model: n.value, checked: check.checked } };
}

// Sheet-level default (sheets.default_ai_model) — overrides the account
// default for runs on that sheet.
export async function setSheetDefaultModel(
  userId: string, sheetId: string, model: unknown,
): Promise<ModelConfigOutcome> {
  const n = normalizeModel(model);
  if ('error' in n) return { fail: 'bad_request', message: n.error };
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const check = await checkDefault(n.value);
  if ('fail' in check) return check.fail;

  const result = db.prepare(
    `UPDATE sheets SET default_ai_model = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ? AND trash_id IS NULL`,
  ).run(n.value, sheetId, userId);
  if (result.changes === 0) return { fail: 'not_found', message: 'Sheet not found' };
  logSheetChange(sheetId, userId, 'default_model',
    n.value ? `Set the sheet's default AI model to ${n.value}` : "Cleared the sheet's default AI model",
    { detail: { model: n.value } });
  return { ok: { model: n.value, checked: check.checked } };
}
