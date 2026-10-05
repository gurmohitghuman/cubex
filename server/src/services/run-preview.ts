// preview_rows for run_ai_column: actually run the prompt on the first N target
// rows and return the sample outputs + a MEASURED cost (from real OpenRouter
// usage) + a full-run projection — the accurate "run 10-50 first" check Clay
// recommends. Spends real AI credits (bounded to PREVIEW_MAX_ROWS) but persists
// NOTHING: no column, no draft, no run row (spec item 4). A later full run
// re-bills these rows (reuse is a deferred optimization).
import { db } from '../lib/db';
import { PREVIEW_MAX_ROWS } from '../lib/constants-ai';
import { resolveAiModel, NO_MODEL_ERROR } from '../lib/ai-model-resolve';
import { unknownPromptRefsError } from '../lib/prompt-ref-validate';
import { fetchModels } from '../lib/openrouter';
import { parseTokenPrice, roundUsd } from '../lib/ai-cost';
import { getOpenRouterClient } from './openrouter';
import { processOneRow } from '../routes/ai-preview-runner';
import {
  buildMultiOutputInstruction, parseMultiOutput, type OutputColumnSpec,
} from '../lib/ai-multi-output';

export interface PreviewInput {
  sheetId: string;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  maxChars: number | null;
  outputColumns?: OutputColumnSpec[];
  previewRows: number;
  targetRowIndexes?: number[];
}

export type PreviewOutcome =
  | { fail: 'not_found' | 'bad_request' | 'no_model' | 'no_rows'; message: string }
  | { ok: Record<string, unknown> };

// The first n target rows (or the first n rows), plus how many the full run
// would touch. Reads only the sample: a sheet can hold a million rows.
// targetRowIndexes come from resolveRowIdsToIndexes, so they already exist.
function sampleRows(
  sheetId: string, userId: string, n: number, targetRowIndexes: number[] | undefined,
): { count: number; sample: Array<{ rowIndex: number; data: Record<string, string> }> } {
  let count: number;
  let picked: Array<{ row_index: number; data: string }>;
  if (targetRowIndexes && targetRowIndexes.length > 0) {
    const targets = [...new Set(targetRowIndexes)].sort((a, b) => a - b);
    count = targets.length;
    const first = targets.slice(0, n);
    picked = db.prepare(
      `SELECT row_index, data FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index IN (${first.map(() => '?').join(',')}) ORDER BY row_index ASC`,
    ).all(sheetId, userId, ...first) as Array<{ row_index: number; data: string }>;
  } else {
    count = (db.prepare('SELECT COUNT(*) AS c FROM rows WHERE sheet_id = ? AND user_id = ?').get(sheetId, userId) as { c: number }).c;
    picked = db.prepare('SELECT row_index, data FROM rows WHERE sheet_id = ? AND user_id = ? ORDER BY row_index ASC LIMIT ?')
      .all(sheetId, userId, n) as Array<{ row_index: number; data: string }>;
  }
  const sample = picked.map(r => ({ rowIndex: r.row_index, data: JSON.parse(r.data) as Record<string, string> }));
  return { count, sample };
}

export async function previewAiRun(userId: string, input: PreviewInput): Promise<PreviewOutcome> {
  if (!db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?').get(input.sheetId, userId)) {
    return { fail: 'not_found', message: 'Sheet not found' };
  }
  const refsError = unknownPromptRefsError(input.sheetId, userId, input.prompt);
  if (refsError) return { fail: 'bad_request', message: refsError };
  const model = resolveAiModel(input.model, input.sheetId, userId);
  if (!model) return { fail: 'no_model', message: NO_MODEL_ERROR };

  const n = Math.max(1, Math.min(input.previewRows, PREVIEW_MAX_ROWS));
  const { count, sample } = sampleRows(input.sheetId, userId, n, input.targetRowIndexes);
  if (sample.length === 0) return { fail: 'no_rows', message: 'No rows to preview.' };

  const specs = input.outputColumns;
  // Multi-column preview asks the model for the same JSON object the real run would.
  const effectivePrompt = specs ? `${input.prompt}\n\n${buildMultiOutputInstruction(specs)}` : input.prompt;

  // The one thing getOpenRouterClient throws for is a missing (or unreadable)
  // key: say so, instead of a 500.
  let openai: Awaited<ReturnType<typeof getOpenRouterClient>>;
  try { openai = await getOpenRouterClient(userId); } catch {
    return { fail: 'bad_request', message: 'No OpenRouter API key is saved, so there is nothing to preview with. Add one in Settings → AI.' };
  }
  const results = await Promise.all(sample.map(row => processOneRow(row, openai, {
    prompt: effectivePrompt, systemPrompt: input.systemPrompt, model,
    safeTemperature: 0.7, maxChars: input.maxChars ?? undefined,
    useOpenRouterWebSearch: false, useWebFetch: false,
    // Structured preview parses JSON below — keep the text verbatim, exactly as
    // the real structured run does (services/ai-row-multi.ts).
    rawText: !!specs,
  })));

  // Shape each sample output; parse structured rows into their typed fields.
  const preview = results.map(r => {
    if (r.error) return { row_index: r.rowIndex, error: r.error };
    if (specs) {
      const parsed = parseMultiOutput(r.value, specs);
      return 'error' in parsed
        ? { row_index: r.rowIndex, error: parsed.error }
        : { row_index: r.rowIndex, fields: parsed.ok };
    }
    return { row_index: r.rowIndex, output: r.value };
  });

  // MEASURED cost from real usage × model pricing.
  const priced = results.filter(r => r.completionTokens !== undefined || r.promptTokens !== undefined);
  let measured: number | null = null;
  let perRow: number | null = null;
  const modelsResult = await fetchModels(Date.now());
  const m = (modelsResult.ok ? modelsResult.models : modelsResult.stale)?.find(x => x.id === model);
  if (m && priced.length > 0) {
    const p = parseTokenPrice(m.pricing.prompt);
    const c = parseTokenPrice(m.pricing.completion);
    const total = priced.reduce((sum, r) => sum + (r.promptTokens ?? 0) * p + (r.completionTokens ?? 0) * c, 0);
    perRow = total / priced.length;
    measured = roundUsd(total);
  }

  return {
    ok: {
      preview,
      sampled_rows: sample.length,
      rows_in_full_run: count,
      model,
      measured_cost_usd: measured,
      per_row_usd: perRow === null ? null : roundUsd(perRow),
      projected_full_run_usd: perRow === null ? null : roundUsd(perRow * count),
      note: 'Preview only — nothing was created or saved. A full run re-processes these rows.',
    },
  };
}
