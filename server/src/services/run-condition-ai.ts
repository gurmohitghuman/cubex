// "Only run if" for the rule box (drawers, auto-run dialog), /api/v1 and MCP:
// check a rule against the sheet (free: how many rows pass, the first rows
// with their verdict), say which model would write one, and write one from
// plain words with ONE call to that model (lib/run-condition-prompt.ts), which
// sees the column names and a few values from the first rows. The rule is then
// checked like any other, and runs check rows against it without the model.
import { db } from '../lib/db';
import { NO_MODEL_ERROR, resolveAiModel } from '../lib/ai-model-resolve';
import { getSheetColumns, parseRowData, verifySheetOwnership } from '../lib/sql-helpers';
import { checkRule, RuleError, type CheckedRule } from '../lib/run-condition';
import { holdsRunMarker } from '../lib/run-markers';
import { CUBEX_PATHS } from '../lib/enrich-run-config';
import { EMAIL_STATUS_WORDS } from '../lib/enrich-email-status';
import { columnSamples, readRuleReply, ruleUserMessage, RULE_SYSTEM_PROMPT } from '../lib/run-condition-prompt';
import { RULE_CHECK_SAMPLE_ROWS, RULE_GENERATE_SAMPLE_ROWS, RULE_WORDS_MAX_CHARS } from '../lib/constants-ai';
import { getOpenRouterClient } from './openrouter';
import { askWriterModel } from './ai-writer-call';
import { scanRule } from './run-condition-rows';
import type { RunFail } from './run-shared';
import { redactSecrets } from '../lib/redact';

export interface RuleCheckResult {
  rule: string; columns: string[];
  rows_checked: number; rows_passing: number; rows_skipped: number;
  sample: Array<{ row_index: number; values: Record<string, string>; passes: boolean }>;
}

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });

export async function checkRuleOnSheet(
  userId: string, sheetId: string, text: string, targets: number[] | null = null,
): Promise<{ ok: RuleCheckResult } | RunFail> {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  let rule: CheckedRule;
  try { rule = checkRule(text, getSheetColumns(sheetId, userId, false)); } catch (e) {
    if (e instanceof RuleError) return bad(e.message);
    throw e;
  }
  const scan = await scanRule({
    sheetId, userId, tree: rule.tree, columns: rule.columns, targets, keepFirst: RULE_CHECK_SAMPLE_ROWS,
  });
  return {
    ok: {
      rule: rule.rule, columns: rule.columns, rows_checked: scan.considered, rows_passing: scan.passing,
      rows_skipped: scan.considered - scan.passing,
      sample: scan.firstRows.map(r => ({ row_index: r.rowIndex, values: r.values, passes: r.passes })),
    },
  };
}

// The model "Generate" would use: the one asked for, else the sheet's default,
// else the account's. Never a built-in one.
export function ruleModel(
  userId: string, sheetId: string, explicit?: string | null,
): { model: string; source: 'picked' | 'sheet' | 'account' } | null {
  const model = resolveAiModel(explicit, sheetId, userId);
  if (!model) return null;
  if (explicit && explicit.trim()) return { model, source: 'picked' };
  const sheet = db.prepare('SELECT default_ai_model FROM sheets WHERE id = ? AND user_id = ?')
    .pluck().get(sheetId, userId) as string | null | undefined;
  return { model, source: sheet ? 'sheet' : 'account' };
}

// Columns whose words are fixed, so the model is told all of them, not just
// the ones in the first rows: an enrichment's "Email status". Only each
// column's newest run is read (a column can hold thousands of auto-run runs).
function fixedWords(sheetId: string, userId: string): Record<string, string[]> {
  const configs = db.prepare(`SELECT config FROM http_runs WHERE rowid IN (
      SELECT MAX(rowid) FROM http_runs WHERE sheet_id = ? AND user_id = ? GROUP BY master_column_name)`)
    .pluck().all(sheetId, userId) as Array<string | null>;
  const out: Record<string, string[]> = {};
  for (const raw of configs) {
    try {
      for (const m of JSON.parse(raw ?? 'null')?.responseMapping ?? []) {
        if (m?.jsonPath === CUBEX_PATHS.email_status && typeof m.columnName === 'string') {
          out[m.columnName] = EMAIL_STATUS_WORDS;
        }
      }
    } catch { /* a malformed config adds nothing */ }
  }
  return out;
}

export interface GeneratedRule {
  model: string; model_source: 'picked' | 'sheet' | 'account'; cost_usd: number | null; check: RuleCheckResult;
}

export async function generateRule(
  userId: string, sheetId: string, words: string, explicitModel?: string | null,
): Promise<{ ok: GeneratedRule } | RunFail | { fail: 'no_model'; message: string }> {
  if (!verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  const asked = words.trim();
  if (!asked) return bad('Say which rows should run, for example: industry is SaaS and more than 50 employees.');
  if (asked.length > RULE_WORDS_MAX_CHARS) return bad(`Keep it under ${RULE_WORDS_MAX_CHARS} characters.`);
  const picked = ruleModel(userId, sheetId, explicitModel);
  if (!picked) return { fail: 'no_model', message: NO_MODEL_ERROR };
  let openai: Awaited<ReturnType<typeof getOpenRouterClient>>;
  try { openai = await getOpenRouterClient(userId); } catch {
    return bad('No OpenRouter API key is saved. Add one in Settings → AI, or write the rule yourself.');
  }
  const columns = getSheetColumns(sheetId, userId, false);
  const rows = (db.prepare(`SELECT data FROM rows WHERE sheet_id = ? AND user_id = ? ORDER BY row_index LIMIT ?`)
    .pluck().all(sheetId, userId, RULE_GENERATE_SAMPLE_ROWS) as string[]).map(parseRowData);
  const samples = { ...columnSamples(columns, rows, holdsRunMarker), ...fixedWords(sheetId, userId) };

  let cost: number | null = null, refused: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    let answer: { text: string; cost: number | null };
    try {
      const user = ruleUserMessage(asked, samples, refused);
      answer = await askWriterModel(openai, picked.model, RULE_SYSTEM_PROMPT, user, 400);
    } catch (error) {
      const why = error instanceof Error ? redactSecrets(error.message).slice(0, 200) : 'no answer';
      const message = `${picked.model} didn't answer (${why}). Try again, or write the rule yourself.`;
      return { fail: 'upstream', message };
    }
    if (answer.cost !== null) cost = (cost ?? 0) + answer.cost;
    const reply = readRuleReply(answer.text);
    if ('cannot' in reply) return bad(`The AI couldn't write that as a rule: ${reply.cannot}`);
    const checked = await checkRuleOnSheet(userId, sheetId, reply.rule);
    if ('ok' in checked) {
      return { ok: { model: picked.model, model_source: picked.source, cost_usd: cost, check: checked.ok } };
    }
    refused = checked.message;
  }
  return bad(`The AI's rule didn't work: ${refused} Try other words, or write the rule yourself.`);
}
