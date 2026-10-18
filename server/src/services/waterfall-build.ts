// A waterfall start request turned into the run's stored config, checked
// against the sheet (input columns), treg's catalog (enrichment steps), the
// AI defaults and prices (AI steps) and the request rules (HTTP steps), and
// frozen: what each step runs, its cap, the row's cap and the run's limit.
// A pure read (the catalog and model prices are cached), so an estimate
// checks exactly what a start would.
import { validateHttpJsonPath } from '../lib/jsonpath-extract';
import { resolveAiModel, NO_MODEL_ERROR } from '../lib/ai-model-resolve';
import { findUnknownColumnReferences, unknownRefsMessage } from '../lib/prompt';
import { httpTemplateError } from '../lib/http-template-validate';
import { WATERFALL_LABEL_MAX_CHARS } from '../lib/constants';
import type { ProviderPick } from '../lib/enrich-estimate';
import type { EnrichTool } from '../lib/enrich-tool';
import {
  newStepId, stepRequestConfig, type WaterfallBlock, type WaterfallStep,
} from '../lib/waterfall/config';
import { rowCaps } from '../lib/waterfall/caps';
import { DEFAULT_PHONE } from '../lib/waterfall/result-type';
import { inputValues, resolveColumn, templateOf } from '../lib/waterfall/inputs';
import { stepReads } from '../lib/waterfall/keys';
import type { StepInput } from '../lib/waterfall/input-steps';
import type { WaterfallRunInput } from '../lib/waterfall/input';
import { buildEnrichmentStep } from './waterfall-build-enrich';
import { buildCheck, compileStepFormula } from './waterfall-build-check';
import { priceAiStep, type AiStepPrice } from './waterfall-ai-price';
import type { RunFail } from './run-shared';

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export interface BuildContext {
  userId: string; sheetId: string;
  columns: string[];                          // the sheet's column registry
  sample: Array<Record<string, string>>;      // a few rows' cells, by column (AI pricing reads their inputs)
  rowsUpperBound: number;                     // the most rows the run can take (the default run limit)
}

// What the estimate needs beside the config: each enrichment step's tool and
// provider pick, each AI step's price notes.
export interface BuiltWaterfall {
  block: WaterfallBlock;
  inputMap: Record<string, string>;
  tools: Map<string, { tool: EnrichTool; pick: ProviderPick }>;
  ai: Map<string, AiStepPrice>;
}

// What "answered by" shows by default: short, since it fills a column.
function enrichLabel(tool: EnrichTool): string {
  if (tool.kind === 'waterfall') return `treg (${tool.providers?.length ?? tool.childCount ?? 0} providers)`;
  const name = tool.providerName ?? tool.provider;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function defaultLabel(s: StepInput, toolName: string | null): string {
  const c = s.choices;
  if (c.kind === 'enrichment') return toolName ?? c.toolId;
  if (c.kind === 'ai') return 'AI';
  if (c.kind === 'http') {
    try { return new URL(c.url.replace(/\{\{[^{}]*\}\}/g, 'x')).hostname || 'HTTP API'; } catch { return 'HTTP API'; }
  }
  return c.kind;
}

// Labels are unique (case aside): "Hunter", "Hunter 2".
function uniqueLabel(label: string, used: Set<string>): string {
  const base = label.slice(0, WATERFALL_LABEL_MAX_CHARS);
  let out = base;
  for (let n = 2; used.has(out.toLowerCase()); n++) out = `${base.slice(0, WATERFALL_LABEL_MAX_CHARS - 4)} ${n}`;
  used.add(out.toLowerCase());
  return out;
}

function inputMapOf(input: WaterfallRunInput, columns: string[]): { map: Record<string, string> } | RunFail {
  const map: Record<string, string> = {};
  for (const i of input.inputs) {
    if (!i.source) continue;
    if ('column' in i.source) {
      const col = resolveColumn(i.source.column, columns);
      if (!col) return bad(`The column "${i.source.column}" (input ${i.label}) isn't in this sheet.`);
      if (/[{}]/.test(col)) return bad(`Rename the column "${col}" first: names with { or } can't be inputs.`);
      map[i.key] = templateOf({ column: col });
    } else map[i.key] = templateOf(i.source);
  }
  return { map };
}

export async function buildWaterfall(
  input: WaterfallRunInput, ctx: BuildContext,
): Promise<{ ok: BuiltWaterfall } | RunFail> {
  const mapped = inputMapOf(input, ctx.columns);
  if ('fail' in mapped) return mapped;
  const inputKeys = input.inputs.map(i => i.key);
  const keySet = new Set(inputKeys);
  // AI prompts name inputs (/full_name), so the sample rows are priced by their input values.
  const sample = ctx.sample.map(row => inputValues(mapped.map, row, [], inputKeys, ctx.columns));
  const mappedKeys = new Set(Object.keys(mapped.map));
  const w = { resultType: input.resultType, phone: input.phone ?? undefined };
  const taken = new Set(input.steps.map(s => s.id).filter((id): id is string => !!id));
  const usedLabels = new Set<string>();
  const tools = new Map<string, { tool: EnrichTool; pick: ProviderPick }>();
  const ai = new Map<string, AiStepPrice>();
  const steps: WaterfallStep[] = [];
  for (const [n, s] of input.steps.entries()) {
    const where = `Step ${n + 1}${s.label ? ` (${s.label})` : ''}`;
    const id = s.id ?? newStepId(taken);
    taken.add(id);
    for (const alt of s.requires ?? []) {
      const unknown = alt.find(k => !keySet.has(k));
      if (unknown) return bad(`${where}: "${unknown}" in requires isn't one of the waterfall's inputs.`);
    }
    const c = s.choices;
    let step: WaterfallStep;
    if (c.kind === 'enrichment') {
      const b = await buildEnrichmentStep(where, c, input.resultType, inputKeys, mappedKeys);
      if ('fail' in b) return b;
      tools.set(id, { tool: b.ok.tool, pick: b.ok.pick });
      step = {
        id, label: '', on: s.on, requires: s.requires ?? [], choices: b.ok.choices, built: b.ok.built,
      };
      step.label = uniqueLabel(s.label ?? enrichLabel(b.ok.tool), usedLabels);
    } else if (c.kind === 'ai') {
      const unknown = findUnknownColumnReferences(c.prompt, inputKeys);
      if (unknown.length) {
        return bad(`${where}: ${unknownRefsMessage(unknown).replace('Unknown column', 'Unknown input')}`);
      }
      const model = resolveAiModel(c.model, ctx.sheetId, ctx.userId);
      if (!model) return bad(`${where}: ${NO_MODEL_ERROR}`);
      const price = await priceAiStep(ctx.userId, w, model, c.prompt, c.webSearch, sample);
      if ('error' in price) return bad(`${where}: ${price.error}`);
      ai.set(id, price.ok);
      const p = price.ok;
      step = {
        id, label: uniqueLabel(s.label ?? defaultLabel(s, null), usedLabels), on: s.on, requires: [],
        choices: { ...c, model }, built: {
          kind: 'ai', model, search: p.search, capUsd: p.capUsd, lowUsd: p.lowUsd, highUsd: p.highUsd,
        },
      };
    } else if (c.kind === 'http') {
      const problem = httpTemplateError(stepRequestConfig(c), inputKeys, ctx.userId);
      if (problem) {
        return bad(`${where}: ${problem.replace('a column of this sheet', "one of the waterfall's inputs")}`);
      }
      const path = validateHttpJsonPath(c.valuePath);
      if (!path.ok) return bad(`${where}: valuePath ${path.reason}`);
      step = {
        id, label: uniqueLabel(s.label ?? defaultLabel(s, null), usedLabels), on: s.on, requires: [],
        choices: c, built: { kind: 'http', retries: c.retries },
      };
    } else if (c.kind === 'formula') {
      const compiled = compileStepFormula(where, c.formula, inputKeys);
      if ('fail' in compiled) return compiled;
      step = {
        id, label: uniqueLabel(s.label ?? 'Formula', usedLabels), on: s.on, requires: [], choices: c,
        built: { kind: 'formula', compiled: compiled.ok },
      };
    } else {
      return bad(`${where}: ${c.kind} steps aren't available yet.`);
    }
    const check = await buildCheck(where, s.check, input.resultType, inputKeys);
    if ('fail' in check) return check;
    if (check.ok) step.check = check.ok;
    // AI and HTTP steps need every input they read, unless the step lists its
    // own alternatives. An enrichment step follows its tool's rule (treg's
    // identity sets, derive included); a tool with none needs one of its inputs.
    if (s.requires) step.requires = s.requires;
    else if (c.kind !== 'enrichment') {
      const reads = stepReads(step, inputKeys);
      step.requires = reads.length ? [reads] : [];
    } else if (!tools.get(id)?.tool.identitySets?.length) {
      step.requires = stepReads(step, inputKeys).map(k => [k]);
    }
    steps.push(step);
  }
  const on = steps.filter(s => s.on);
  if (on.length === 0) return bad('Switch at least one step on.');
  const { most: maxCost, treg: tregCap } = rowCaps(on);
  const byRows = maxCost > 0 ? round6(Math.max(ctx.rowsUpperBound, 1) * maxCost) : null;
  const spendLimit = input.spendLimitUsd ?? byRows;
  if (spendLimit !== null && maxCost > 0 && spendLimit + 1e-6 < maxCost) {
    return bad(`The run limit ($${spendLimit}) is below the most a row can cost ($${maxCost}), so no row could run. `
      + 'Raise the run limit.');
  }
  if (input.dry?.only && !steps.some(s => s.id === input.dry!.only)) {
    return bad('dry.only names no step of this waterfall.');
  }
  const block: WaterfallBlock = {
    v: 1, resultType: input.resultType,
    ...(input.resultType === 'phone' ? { phone: input.phone ?? DEFAULT_PHONE } : {}),
    inputs: input.inputs.map(i => ({ key: i.key, label: i.label })), steps, hideStepColumns: input.hideStepColumns,
    maxCostPerRowUsd: maxCost, tregCapPerRowUsd: tregCap, spendLimitUsd: spendLimit,
    rows: { mode: input.rows.mode, status: input.rows.status, test: input.rows.test },
    fresh: input.fresh, ...(input.noReuse ? { noReuse: true } : {}),
  };
  return { ok: { block, inputMap: mapped.map, tools, ai } };
}
