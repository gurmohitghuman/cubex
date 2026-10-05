import { db } from './db';
import { DEFAULT_AI_CONCURRENCY } from './constants-ai';

// Resolve which model an AI-column run/preview uses. Order: explicit choice in
// the request > sheet default (sheets.default_ai_model) > account default
// (settings.default_ai_model, migration 032). Returns null when none is set —
// callers MUST reject with NO_MODEL_ERROR rather than fall back to a hardcoded
// model: every AI call (columns, previews, HTTP-config assist) only ever runs
// on a model the user chose, directly or via one of their defaults.
export function resolveAiModel(
  explicitModel: unknown, sheetId: string, userId: string,
): string | null {
  if (typeof explicitModel === 'string' && explicitModel.trim()) {
    return explicitModel.trim();
  }
  const sheet = db.prepare('SELECT default_ai_model FROM sheets WHERE id = ? AND user_id = ?')
    .get(sheetId, userId) as { default_ai_model: string | null } | undefined;
  if (sheet?.default_ai_model) return sheet.default_ai_model;
  return getAccountDefaultModel(userId);
}

export function getAccountDefaultModel(userId: string): string | null {
  const settings = db.prepare('SELECT default_ai_model FROM settings WHERE user_id = ?')
    .get(userId) as { default_ai_model: string | null } | undefined;
  return settings?.default_ai_model || null;
}

// Read on every surface (web panel, REST, MCP), so it names each way to fix it.
export const NO_MODEL_ERROR =
  'No AI model selected. Choose one for this run (the model field), or set a default model '
  + '(Settings → AI, or set_default_model over MCP).';

// Resolve a run's request fan-out. Order mirrors resolveAiModel: explicit value
// in the request > sheet default (sheets.default_ai_concurrency, migration 025)
// > DEFAULT_AI_CONCURRENCY.
//
// Unlike the model there IS a safe fallback, so this never returns null.
//
// Why this exists: the AI-column modal sends `concurrency` on every run, but the
// MCP tool and /api/v1 callers that omit it fell through to the parse-layer
// default of 5 — so a sheet with default_ai_concurrency = 97 still ran 5-wide
// from an agent, and the stored setting was written and displayed but never read
// by any run path. A 1,735-row run measured ~0.45 rows/sec (effective
// concurrency ~1 after per-row latency), which read as "runs are serial" but was
// really "runs are pinned at the parse default".
export function resolveAiConcurrency(
  explicitConcurrency: unknown, sheetId: string, userId: string,
): number {
  if (typeof explicitConcurrency === 'number' && Number.isFinite(explicitConcurrency)) {
    return explicitConcurrency;
  }
  const sheet = db.prepare('SELECT default_ai_concurrency FROM sheets WHERE id = ? AND user_id = ?')
    .get(sheetId, userId) as { default_ai_concurrency: number | null } | undefined;
  const stored = sheet?.default_ai_concurrency;
  if (typeof stored === 'number' && Number.isFinite(stored) && stored > 0) return stored;
  return DEFAULT_AI_CONCURRENCY;
}

// Shared shape check for a model id arriving in a request body. OpenRouter ids
// are short slugs ("openai/gpt-4o-mini"); 200 matches the sheet default-model
// route's bound. Returns an error string or null when acceptable (undefined /
// null / '' are acceptable — they mean "resolve from defaults").
export function validateModelParam(model: unknown): string | null {
  if (model === undefined || model === null || model === '') return null;
  if (typeof model !== 'string' || model.length > 200) return 'Invalid model value';
  return null;
}
