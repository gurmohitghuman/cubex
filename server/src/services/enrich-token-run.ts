// run_enrichment for the token surfaces (MCP and POST /api/v1/sheets/:id/
// enrichment-runs), in one place so the two can't drift: the agent's
// arguments become the drawer's request (lib/enrich-agent-input.ts) and go
// through the same parser and start (services/enrich-run-start.ts). On top,
// as for AI and HTTP runs (run-start-token.ts): estimate_only as a pure read,
// idempotency keys, the per-token run-start window. And auto_run: turned on
// for the column once the run has started, as the drawer's checkbox does.
import { db } from '../lib/db';
import { TREG_TOOL_ID_PATTERN } from '../lib/constants';
import { MAX_SELECTED_ROWS, parseEnrichRunInput } from '../lib/enrich-run-input';
import { agentRunBody, flagOf, unknownArgument, type AgentRunArgs } from '../lib/enrich-agent-input';
import { runRequestHash, writeRunLedger } from '../lib/run-idempotency';
import { parseBooleanOption } from '../lib/web-search-options';
import { getTool } from './enrich-catalog';
import { startEnrichmentRun } from './enrich-run-start';
import { agentEnrichEstimate } from './enrich-token-estimate';
import { saveAutorunSettings } from './autorun-settings';
import { sheetAutorunView } from './autorun-view';
import { dailyLimitOf } from './enrich-agent-shared';
import { appendAutorunNotice, autorunColumnJson } from './enrich-agent-autorun';
import { bad, ledgerReplay, preamble, startWindow, type TokenCaller, type TokenRunResult } from './run-start-token';

export interface TokenEnrichArgs extends AgentRunArgs {
  sheet_id: unknown; target_row_ids?: unknown; estimate_only?: unknown; idempotency_key?: unknown;
  auto_run?: unknown;
}

type AutoRun = { enabled: boolean; dailyCapUsd: number | null } | null;

function autoRunOf(v: unknown): AutoRun | string {
  if (v === undefined || v === null) return null;
  const o = (typeof v === 'object' && !Array.isArray(v) ? v : null) as Record<string, unknown> | null;
  const enabled = flagOf(o?.enabled);
  if (!o || enabled === undefined || enabled === 'invalid') return 'auto_run needs enabled: true or false.';
  const cap = o.daily_cap_usd;
  if (cap !== undefined && cap !== null && (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0)) {
    return 'auto_run.daily_cap_usd must be more than $0.';
  }
  return { enabled, dailyCapUsd: typeof cap === 'number' ? cap : null };
}

const generationOf = (sheetId: string, userId: string): number | null => (db.prepare(
  'SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?',
).pluck().get(sheetId, userId) as number | undefined) ?? null;

export async function tokenStartEnrichmentRun(c: TokenCaller, a: TokenEnrichArgs): Promise<TokenRunResult> {
  const unknown = unknownArgument(a as unknown as Record<string, unknown>);
  if (unknown) return bad(unknown);
  if (Array.isArray(a.target_row_ids) && a.target_row_ids.length > MAX_SELECTED_ROWS) {
    return bad(`target_row_ids takes at most ${MAX_SELECTED_ROWS.toLocaleString('en-US')} rows a run.`);
  }
  // Read before the row ids resolve: a sort in between moves the generation,
  // and the start then refuses instead of running other rows.
  const generation = typeof a.sheet_id === 'string' ? generationOf(a.sheet_id, c.userId) : null;
  const pre = preamble(c, a);
  if ('fail' in pre) return pre;
  const sheetId = a.sheet_id as string;
  if (typeof a.tool_id !== 'string' || !TREG_TOOL_ID_PATTERN.test(a.tool_id)) {
    return bad('tool_id must be a tool id from search_enrichments (GET /api/v1/enrichments).');
  }
  const found = await getTool(a.tool_id);
  if (!('ok' in found)) {
    const upstream = found.fail === 'unreachable' || found.fail === 'upstream';
    return { fail: upstream ? 'upstream' : 'bad_request', message: found.message };
  }
  const body = agentRunBody(a, found.ok, pre.targetRowIndexes ?? null, pre.targetRowIndexes ? generation : null);
  if ('error' in body && typeof body.error === 'string') return bad(body.error);
  const parsed = parseEnrichRunInput(body);
  if ('error' in parsed) return bad(parsed.error);
  const autoRun = autoRunOf(a.auto_run);
  if (typeof autoRun === 'string') return bad(autoRun);

  if (parseBooleanOption(a.estimate_only) === true) {
    const est = await agentEnrichEstimate(c.userId, sheetId, parsed.ok);
    return 'fail' in est ? est : { ok: est.ok, started: false };
  }
  const { rowGeneration: _gen, rows, ...rest } = parsed.ok;
  const hash = runRequestHash('enrichment_run', {
    sheet_id: sheetId, input: { ...rest, rows: { ...rows, rowIndexes: null } },
    target_row_ids: a.target_row_ids ?? null, auto_run: autoRun,
  });
  const replay = ledgerReplay(c, a.idempotency_key, hash);
  if (replay) return replay;
  const limited = startWindow(c);
  if (limited) return limited;
  const out = await startEnrichmentRun(c.userId, sheetId, parsed.ok);
  if ('fail' in out) return out;
  const run = db.prepare('SELECT config FROM http_runs WHERE id = ? AND user_id = ?').pluck()
    .get(out.ok.runId, c.userId) as string;
  const e = JSON.parse(run).enrichment as { maxCostPerRowUsd: number | null; spendLimitUsd: number | null };

  let autoRunPart: Record<string, unknown> = {};
  if (autoRun) {
    const saved = await saveAutorunSettings(c.userId, sheetId, {
      column: out.ok.statusColumn, enabled: autoRun.enabled, where: null,
      dailyCapUsd: autoRun.dailyCapUsd, dailyRowCap: null,
    }, { hasSecretsScope: false });
    const view = sheetAutorunView(sheetId, c.userId).columns[out.ok.statusColumn];
    autoRunPart = 'fail' in saved
      ? { auto_run_error: `The run started, but auto-run wasn't turned on: ${saved.message}` }
      : { auto_run: view ? autorunColumnJson(view) : null };
  }
  // A list job's rows set off the destination's own auto-runs.
  const list = parsed.ok.list;
  // The auto-runs here that read what this run writes (and what those write
  // in turn). Both are read at once, so the answer waits one price lookup.
  const runRows = parsed.ok.rows.test ? Math.min(parsed.ok.rows.test, out.ok.rowsInScope) : out.ok.rowsInScope;
  const [destNotice, chain] = await Promise.all([
    out.ok.destSheetId && list
      ? appendAutorunNotice(c.userId, out.ok.destSheetId, out.ok.rowsInScope * list.maxItems)
      : Promise.resolve<{ auto_run?: unknown[] }>({}),
    appendAutorunNotice(c.userId, sheetId, runRows, [out.ok.statusColumn, ...out.ok.outputColumns]),
  ]);
  const payload = {
    run_id: out.ok.runId, run_type: 'enrichment', status_column: out.ok.statusColumn,
    output_columns: out.ok.outputColumns, destination_sheet_id: out.ok.destSheetId,
    rows_in_scope: out.ok.rowsInScope, test_rows: parsed.ok.rows.test,
    max_cost_per_row_usd: e.maxCostPerRowUsd, spend_limit_usd: e.spendLimitUsd,
    daily_limit: dailyLimitOf(c.userId), ...autoRunPart,
    ...(destNotice.auto_run ? { destination_auto_run: destNotice.auto_run } : {}),
    ...(chain.auto_run ? { chained_auto_run: chain.auto_run } : {}),
  };
  if (typeof a.idempotency_key === 'string') {
    writeRunLedger(c.userId, a.idempotency_key, hash, 'enrichment_run', payload);
  }
  return { ok: payload, started: true };
}
