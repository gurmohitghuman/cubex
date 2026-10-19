// "Write it with AI" in the Formula dialog, /api/v1 and MCP write_formula: a
// formula from plain words with ONE call to the sheet's model (the one an
// "Only run if" rule is written with), which sees the column names and what
// the first rows hold (lib/formula-prompt.ts). The formula is then previewed
// like any other: it must compile and work out at least one sample row; if not,
// the model is told why and tries once more. Nothing is saved: the person (or
// agent) reads it and saves it as a formula column, which costs nothing per row.
import { db } from '../lib/db';
import { NO_MODEL_ERROR } from '../lib/ai-model-resolve';
import { getSheetColumns, parseRowData, verifySheetOwnership } from '../lib/sql-helpers';
import { holdsRunMarker } from '../lib/run-markers';
import { redactSecrets } from '../lib/redact';
import { FORMULA_SAMPLE_ROWS, FORMULA_WORDS_MAX_CHARS } from '../lib/constants';
import { FORMULA_SYSTEM_PROMPT, formulaSamples, formulaUserMessage, readFormulaReply } from '../lib/formula-prompt';
import { getOpenRouterClient } from './openrouter';
import { askWriterModel, type WriterClient } from './ai-writer-call';
import { ruleModel } from './run-condition-ai';
import { previewFormulaColumn, type FormulaPreview } from './formula-preview';
import type { RunFail } from './run-shared';
import { actorSpendRefusal } from './token-spend';
import { addCall, noSpend, recordCallUsage } from './usage-calls';

export interface WrittenFormula {
  model: string; model_source: 'picked' | 'sheet' | 'account'; cost_usd: number | null;
  formula: string; preview: FormulaPreview;
}

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

// Why a previewed formula isn't good enough to hand back, or null.
function previewProblem(p: FormulaPreview): string | null {
  if (p.stopped) return p.stopped;
  const errors = p.samples.filter(s => s.error);
  if (p.samples.length > 0 && errors.length === p.samples.length) {
    return `It gave an error on every sample row, like "${errors[0].error}".`;
  }
  return null;
}

export async function writeFormula(
  userId: string, sheetId: string, words: string, explicitModel?: string | null,
): Promise<{ ok: WrittenFormula } | RunFail> {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const capped = actorSpendRefusal(userId);
  if (capped) return { fail: 'forbidden', message: capped };
  const asked = words.trim();
  if (!asked) return bad('Say what the column should hold, for example: the work email from Response.');
  if (asked.length > FORMULA_WORDS_MAX_CHARS) return bad(`Keep it under ${FORMULA_WORDS_MAX_CHARS} characters.`);
  const picked = ruleModel(userId, sheetId, explicitModel);
  if (!picked) return { fail: 'no_model', message: NO_MODEL_ERROR };
  let openai: WriterClient;
  try { openai = await getOpenRouterClient(userId); } catch {
    return bad('No OpenRouter API key is saved. Add one in Settings → AI, or write the formula yourself.');
  }
  const columns = getSheetColumns(sheetId, userId, false);
  const rows = (db.prepare('SELECT data FROM rows WHERE sheet_id = ? AND user_id = ? ORDER BY row_index LIMIT ?')
    .pluck().all(sheetId, userId, FORMULA_SAMPLE_ROWS) as string[]).map(parseRowData);
  const samples = formulaSamples(columns, rows, holdsRunMarker);
  // Every call it makes goes in the usage history as an AI helper's (services/usage-calls.ts).
  const spent = noSpend();
  const ask = async (user: string) => {
    const answer = await askWriterModel(openai, picked.model, FORMULA_SYSTEM_PROMPT, user, 600);
    addCall(spent, { costUsd: answer.cost, providerCostUsd: answer.providerCost });
    return answer;
  };
  const message = (retry?: string) => formulaUserMessage(asked, samples, retry);
  let out: Awaited<ReturnType<typeof formulaAttempts>>;
  try { out = await formulaAttempts(userId, sheetId, ask, message); } finally {
    recordCallUsage(userId, sheetId, null, 'assist', spent);
  }
  if ('upstream' in out) {
    const why = `${picked.model} didn't answer (${out.upstream}).`;
    return { fail: 'upstream', message: `${why} Try again, or write the formula yourself.` };
  }
  if ('fail' in out) return out;
  return { ok: { model: picked.model, model_source: picked.source, ...out.ok } };
}

type Ask = (user: string) => Promise<{ text: string; cost: number | null }>;

// The model's tries (two at most): each reply is previewed; a refusal is told
// back to the model once. ask is the call (a test passes its own).
export async function formulaAttempts(
  userId: string, sheetId: string, ask: Ask, message: (retry?: string) => string,
): Promise<{ ok: Omit<WrittenFormula, 'model' | 'model_source'> } | RunFail | { upstream: string }> {
  let cost: number | null = null, refused: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    let answer: { text: string; cost: number | null };
    try {
      answer = await ask(message(refused));
    } catch (error) {
      return { upstream: error instanceof Error ? redactSecrets(error.message).slice(0, 200) : 'no answer' };
    }
    if (answer.cost !== null) cost = (cost ?? 0) + answer.cost;
    const reply = readFormulaReply(answer.text);
    if ('cannot' in reply) return bad(`The AI couldn't write that as a formula: ${reply.cannot}`);
    const p = await previewFormulaColumn(userId, sheetId, { formula: reply.formula });
    if ('fail' in p && p.fail !== 'bad_request') return p;
    refused = 'fail' in p ? p.message : previewProblem(p.ok) ?? undefined;
    if ('ok' in p && !refused) return { ok: { cost_usd: cost, formula: p.ok.formula, preview: p.ok } };
  }
  return bad(`The AI's formula didn't work: ${refused} Try other words, or write the formula yourself.`);
}
