// waterfall_column's arguments (MCP, and the body of POST /api/v1/sheets/:id/
// waterfall-columns) as the app's start request (lib/waterfall/input.ts),
// pure. A name Cubex doesn't know is refused at every level, never dropped (a
// misspelled estimate_only must not start a paid run). Run again on a column
// (add_to_column) with no inputs or steps given, its own are used; a step
// given without an id keeps the id of the column's step with the same label,
// so its column stays the same. An HTTP step sent back with values a setup
// read hid gets its stored ones (lib/waterfall/agent-mask.ts).
import { strayKey } from '../enrich-agent-args';
import { ENRICH_TEST_ROWS } from '../constants';
import { RESULT_INFO, isResultType } from './result-type';
import { INPUT_KEY_PATTERN } from './inputs';
import type { WaterfallRunInput } from './input';
import type { HttpChoices, WaterfallRunConfig } from './config';
import { restoreMaskedStep } from './agent-mask';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

export const AGENT_TOP = ['sheet_id', 'column_name', 'add_to_column', 'result_type', 'phone', 'inputs', 'steps',
  'answered_by_column', 'hide_step_columns', 'rows', 'test', 'use_sheet_filter', 'target_row_ids', 'run_if',
  'spend_limit_usd', 'concurrency', 'fresh', 'estimate_only', 'idempotency_key', 'webhook_id', 'auto_run',
  'action'];
const STEP_KEYS: Record<string, string[]> = {
  enrichment: ['tool_id', 'inputs', 'value_path', 'provider_order', 'skip_providers', 'stop_at_first',
    'max_cost_usd'],
  ai: ['prompt', 'model', 'web_search'],
  http: ['method', 'url', 'headers', 'body', 'value_path', 'retries'],
};
const COMMON = ['id', 'label', 'on', 'requires', 'kind'];
// Which of a continued column's rows run: run_enrichment's words, or control_run's.
const STATUS: Record<string, string> = {
  any: 'any', not_enriched: 'not_enriched', no_result: 'no_result', failed: 'failed',
  empty: 'not_enriched', errored: 'failed', missing: 'no_result', all: 'any',
};

const words = (key: string): string => key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

function labelOf(key: string, resultType: unknown): string {
  const known = isResultType(resultType) ? RESULT_INFO[resultType].inputs.find(i => i.key === key) : undefined;
  const any = Object.values(RESULT_INFO).flatMap(r => r.inputs).find(i => i.key === key);
  return known?.label ?? any?.label ?? words(key);
}

function inputsOf(v: unknown, resultType: unknown): unknown[] | string {
  if (!isObj(v)) {
    return 'inputs must map input keys (such as full_name) to a column name, {"column": ...} or {"value": ...}.';
  }
  return Object.entries(v).map(([key, src]) => {
    if (!INPUT_KEY_PATTERN.test(key)) return { key, label: key, source: null };
    const source = typeof src === 'string' ? { column: src } : src === null ? null : src;
    return { key, label: labelOf(key, resultType), source };
  });
}

function stepOf(v: unknown, i: number): { ok: Json } | { error: string } {
  const where = `steps[${i}]`;
  if (!isObj(v)) return { error: `${where} must be an object.` };
  const kind = typeof v.kind === 'string' ? v.kind : '';
  const own = STEP_KEYS[kind];
  if (!own) return { error: `${where}.kind is enrichment, ai or http.` };
  const stray = strayKey(v, [...COMMON, ...own], where);
  if (stray) return { error: stray };
  const choices: Json = kind === 'enrichment' ? {
    kind, toolId: v.tool_id, inputs: v.inputs, valuePath: v.value_path, providerOrder: v.provider_order,
    skipProviders: v.skip_providers, stopAtFirst: v.stop_at_first, maxCostUsd: v.max_cost_usd,
  } : kind === 'ai' ? { kind, prompt: v.prompt, model: v.model, webSearch: v.web_search }
    : {
      kind, method: v.method, url: v.url, headers: v.headers, body: v.body, valuePath: v.value_path,
      retries: v.retries,
    };
  for (const [k, val] of Object.entries(choices)) if (val === undefined) delete choices[k];
  return { ok: { id: v.id, label: v.label, on: v.on, requires: v.requires, choices } };
}

export function agentWaterfallBody(
  a: Json, prior: WaterfallRunConfig | null, recalled: WaterfallRunInput | null,
  target: { rowIndexes: number[] | null; generation: number | null },
): { ok: Json } | { error: string } {
  const stray = strayKey(a, AGENT_TOP, '');
  if (stray) return { error: `${stray} Nothing was started.` };
  const cont = a.add_to_column === true;
  if (cont && !recalled) return { error: `"${String(a.column_name)}" isn't a waterfall column to add to.` };
  const resultType = a.result_type ?? recalled?.resultType;
  let inputs: unknown = recalled?.inputs;
  if (a.inputs !== undefined) {
    const got = inputsOf(a.inputs, resultType);
    if (typeof got === 'string') return { error: got };
    inputs = got;
  }
  let steps: unknown = recalled?.steps;
  if (a.steps !== undefined) {
    if (!Array.isArray(a.steps)) return { error: 'steps must be a list.' };
    const out: Json[] = [];
    for (const [i, s] of a.steps.entries()) {
      const r = stepOf(s, i);
      if ('error' in r) return r;
      out.push(r.ok);
    }
    // A step given without an id keeps its column's step of the same label.
    const used = new Set(out.map(s => s.id).filter(Boolean));
    for (const s of out) {
      if (s.id || typeof s.label !== 'string' || !prior) continue;
      const same = prior.waterfall.steps.find(p => p.label.toLowerCase() === (s.label as string).toLowerCase()
        && !used.has(p.id));
      if (same) { s.id = same.id; used.add(same.id); }
    }
    for (const [i, s] of out.entries()) {
      const c = s.choices as Json;
      if (c.kind !== 'http') continue;
      const p = prior?.waterfall.steps.find(x => x.id === s.id && x.choices?.kind === 'http');
      const problem = restoreMaskedStep(c, (p?.choices as HttpChoices | undefined) ?? null, `steps[${i}]`);
      if (problem) return { error: problem };
    }
    steps = out;
  }
  if (a.auto_run !== undefined && !isObj(a.auto_run)) return { error: 'auto_run must be {enabled, daily_cap_usd?}.' };
  const status = a.rows === undefined ? (cont ? 'not_enriched' : 'any') : STATUS[String(a.rows)];
  if (!status) return { error: 'rows is not_enriched, no_result, failed or any (which rows of the column run).' };
  if (a.test !== undefined && a.test !== true && a.test !== false
    && !(typeof a.test === 'number' && Number.isInteger(a.test) && a.test >= 1)) {
    return { error: 'test is true (the first 5 rows) or a number of rows.' };
  }
  const test = a.test === true ? ENRICH_TEST_ROWS : typeof a.test === 'number' ? a.test : null;
  const filter = a.use_sheet_filter === true;
  return {
    ok: {
      columnName: a.column_name, continueColumn: cont, resultType, phone: a.phone ?? recalled?.phone ?? undefined,
      inputs, steps, answeredBy: a.answered_by_column ?? recalled?.answeredBy, runIf: a.run_if,
      hideStepColumns: a.hide_step_columns ?? recalled?.hideStepColumns,
      rows: {
        mode: target.rowIndexes ? 'selected' : filter ? 'filter' : 'all', status, test,
        ...(target.rowIndexes ? { rowIndexes: target.rowIndexes } : {}),
      },
      spendLimitUsd: a.spend_limit_usd, concurrency: a.concurrency, fresh: a.fresh,
      rowGeneration: target.generation,
    },
  };
}
