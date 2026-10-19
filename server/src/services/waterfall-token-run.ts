// waterfall_column for the token surfaces (MCP and POST /api/v1/sheets/:id/
// waterfall-columns), in one place so the two can't drift: the agent's
// arguments become the app's start request (lib/waterfall/agent-args.ts) and
// go through the same parser, estimate and start. On top, as for every run
// start over a token (run-start-token.ts): estimate_only as a pure read,
// idempotency keys, the per-token run-start window, a webhook, the 'secrets'
// scope for an HTTP step reading a saved key, and auto_run turned on once the
// run has started. action 'describe' reads a column's setup instead.
import { db } from '../lib/db';
import { runRequestHash, writeRunLedger } from '../lib/run-idempotency';
import { parseBooleanOption } from '../lib/web-search-options';
import { parseWaterfallInput } from '../lib/waterfall/input';
import { agentWaterfallBody } from '../lib/waterfall/agent-args';
import { flagOf } from '../lib/enrich-agent-input';
import { estimateWaterfall } from './waterfall-estimate';
import { startWaterfallRun } from './waterfall-run-start';
import { newestWaterfallRun, recallInput, waterfallSetup } from './waterfall-column';
import { saveAutorunSettings } from './autorun-settings';
import { sheetAutorunView } from './autorun-view';
import { appendAutorunNotice, autorunColumnJson } from './enrich-agent-autorun';
import { attachRunWebhook, webhookIdProblem } from './run-hooks-attach';
import { dailyLimitOf } from './enrich-agent-shared';
import { runIfReply } from './run-rule';
import { bad, ledgerReplay, preamble, startWindow, type TokenCaller, type TokenRunResult } from './run-start-token';
import { agentSetup } from './waterfall-agent-view';
import { tokenDryRun } from './waterfall-token-dry';
import { spendPart } from './token-spend';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

type AutoRun = { enabled: boolean; dailyCapUsd: number | null; dailyRowCap: number | null } | null;

function autoRunOf(v: unknown): AutoRun | string {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) return 'auto_run needs enabled: true or false.';
  const stray = Object.keys(v).find(k => !['enabled', 'daily_cap_usd', 'daily_row_cap'].includes(k));
  if (stray) return `Unknown argument auto_run.${stray}.`;
  const enabled = flagOf(v.enabled);
  if (enabled === undefined || enabled === 'invalid') return 'auto_run needs enabled: true or false.';
  const cap = v.daily_cap_usd, rows = v.daily_row_cap;
  if (cap !== undefined && cap !== null && (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0)) {
    return 'auto_run.daily_cap_usd must be more than $0.';
  }
  if (rows !== undefined && rows !== null && (typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1)) {
    return 'auto_run.daily_row_cap must be a whole number of rows.';
  }
  return {
    enabled, dailyCapUsd: typeof cap === 'number' ? cap : null, dailyRowCap: typeof rows === 'number' ? rows : null,
  };
}

const generationOf = (sheetId: string, userId: string): number | null => (db.prepare(
  'SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?',
).pluck().get(sheetId, userId) as number | undefined) ?? null;

// estimateDefault: what an absent estimate_only means (MCP true: a waterfall is paid and has many steps).
export async function tokenWaterfall(
  c: TokenCaller, a: Json, opts: { estimateDefault: boolean },
): Promise<TokenRunResult> {
  if (a.action !== undefined && a.action !== 'run' && a.action !== 'describe') {
    return bad("action is 'run' or 'describe'.");
  }
  if (a.action === 'describe') {
    const stray = Object.keys(a).find(k => !['action', 'sheet_id', 'column_name'].includes(k));
    if (stray) return bad(`describe takes sheet_id and column_name only (got ${stray}).`);
    if (typeof a.sheet_id !== 'string' || typeof a.column_name !== 'string') {
      return bad('Pass sheet_id and column_name.');
    }
    const setup = waterfallSetup(a.sheet_id, c.userId, a.column_name);
    return 'fail' in setup ? setup : { ok: agentSetup(setup.ok, { secrets: c.scopes.has('secrets') }), started: false };
  }
  const generation = typeof a.sheet_id === 'string' ? generationOf(a.sheet_id, c.userId) : null;
  const pre = preamble(c, a as Parameters<typeof preamble>[1]);
  if ('fail' in pre) return pre;
  const sheetId = a.sheet_id as string;
  if (typeof a.column_name !== 'string' || !a.column_name.trim()) return bad('column_name is required.');
  const prior = a.add_to_column === true ? newestWaterfallRun(sheetId, c.userId, a.column_name) : null;
  const recalled = prior ? recallInput(prior.config, a.column_name) : null;
  const body = agentWaterfallBody(a, prior?.config ?? null, recalled,
    { rowIndexes: pre.targetRowIndexes ?? null, generation: pre.targetRowIndexes ? generation : null });
  if ('error' in body) return bad(body.error);
  const parsed = parseWaterfallInput(body.ok);
  if ('error' in parsed) return bad(parsed.error.replace(/^runIf/, 'run_if'));
  const autoRun = autoRunOf(a.auto_run);
  if (typeof autoRun === 'string') return bad(autoRun);
  if (parsed.ok.dry) return tokenDryRun(c, sheetId, parsed.ok, a);
  const hookProblem = webhookIdProblem(c.userId, a.webhook_id);
  if (hookProblem) return bad(hookProblem);
  const estimateOnly = a.estimate_only === undefined
    ? opts.estimateDefault
    : parseBooleanOption(a.estimate_only) === true;
  if (estimateOnly) {
    const est = await estimateWaterfall(c.userId, sheetId, parsed.ok);
    if ('fail' in est) return est;
    return {
      ok: { estimate_only: true, ...est.ok, note: 'Nothing was started. Run it with estimate_only: false.' },
      started: false,
    };
  }
  const { rowGeneration: _gen, rows, ...rest } = parsed.ok;
  const hash = runRequestHash('waterfall_run', {
    sheet_id: sheetId, input: { ...rest, rows: { ...rows, rowIndexes: null } },
    target_row_ids: a.target_row_ids ?? null, auto_run: autoRun, ...(a.webhook_id ? { webhook_id: a.webhook_id } : {}),
  });
  const replay = ledgerReplay(c, a.idempotency_key, hash);
  if (replay) return replay;
  const limited = startWindow(c);
  if (limited) return limited;
  const out = await startWaterfallRun(c.userId, sheetId, parsed.ok, { hasSecretsScope: c.scopes.has('secrets') });
  if ('fail' in out) return out;
  const hook = typeof a.webhook_id === 'string' ? a.webhook_id : null;
  if (hook) attachRunWebhook('http_runs', out.ok.runId, c.userId, hook);
  const stored = JSON.parse(db.prepare('SELECT config FROM http_runs WHERE id = ? AND user_id = ?').pluck()
    .get(out.ok.runId, c.userId) as string) as { runIf?: string; waterfall: { maxCostPerRowUsd: number;
    spendLimitUsd: number | null; steps: Array<{ id: string; label: string; on: boolean }> } };
  let autoRunPart: Json = {};
  if (autoRun) {
    const saved = await saveAutorunSettings(c.userId, sheetId, {
      column: out.ok.resultColumn, enabled: autoRun.enabled, where: null,
      dailyCapUsd: autoRun.dailyCapUsd, dailyRowCap: autoRun.dailyRowCap,
    }, { hasSecretsScope: c.scopes.has('secrets') });
    const view = sheetAutorunView(sheetId, c.userId).columns[out.ok.resultColumn];
    autoRunPart = 'fail' in saved
      ? { auto_run_error: `The run started, but auto-run wasn't turned on: ${saved.message}` }
      : { auto_run: view ? autorunColumnJson(view) : null };
  }
  const runRows = parsed.ok.rows.test ? Math.min(parsed.ok.rows.test, out.ok.rowsInScope) : out.ok.rowsInScope;
  const chain = await appendAutorunNotice(c.userId, sheetId, runRows, [out.ok.resultColumn, ...out.ok.outputColumns]);
  const w = stored.waterfall;
  const payload = {
    run_id: out.ok.runId, run_type: 'waterfall', result_column: out.ok.resultColumn,
    output_columns: out.ok.outputColumns, rows_in_scope: out.ok.rowsInScope, test_rows: parsed.ok.rows.test,
    steps: w.steps.map(s => ({ id: s.id, label: s.label, on: s.on })),
    max_cost_per_row_usd: w.maxCostPerRowUsd, spend_limit_usd: w.spendLimitUsd, daily_limit: dailyLimitOf(c.userId),
    ...(stored.runIf ? runIfReply(stored.runIf) : {}), ...autoRunPart,
    ...(chain.auto_run ? { chained_auto_run: chain.auto_run } : {}), ...(hook ? { webhook_id: hook } : {}),
  };
  if (typeof a.idempotency_key === 'string') {
    writeRunLedger(c.userId, a.idempotency_key, hash, 'waterfall_run', payload);
  }
  return { ok: { ...payload, ...spendPart(c.userId, c.tokenId) }, started: true };
}
