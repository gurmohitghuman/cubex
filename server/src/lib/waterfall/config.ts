// Over 200 lines: the waterfall's stored shape (choices, frozen steps, checks, the block) and its readers.
// The `waterfall` block a waterfall run keeps in http_runs.config (pure). A
// waterfall column fills one result per row by trying ordered steps and
// stopping at the first answer (services/waterfall-*.ts). Like an enrichment
// (lib/enrich-run-config.ts) the rest of the config is a normal HTTP config,
// so placeholders, resume, locked columns, rename/delete, SSE and Stop all
// work unchanged, and the block itself names no sheet column:
// - requestConfig.body holds the input map ({key: "{{Column}}" | value},
//   lib/waterfall/inputs.ts); nothing is ever sent from requestConfig;
// - responseMapping holds the run's other columns: "$.answered_by" and
//   "$.steps.<step id>", so a renamed or deleted column follows by itself;
// - master_column_name is the result column, runIf the "Only run if" rule.
// Everything the worker runs is frozen at start in each step's `built`, so a
// run never reads the catalog mid-way and a resume calls what the start priced.
import { randomBytes } from 'node:crypto';
import type { HTTPAPIConfig, HTTPRequestConfig } from '../http-request-template';
import type { EnrichRoute, EnrichRowsMode, EnrichRowsStatus } from '../enrich-run-config';
import type { RequestTool } from '../enrich-request';
import type { SearchToolConfig } from '../ai-web-tools';
import type { PhoneResult, ResultType, WaterfallInputDef } from './result-type';
import type { CompiledFormula } from '../formula/refs';
import type { EmailStrategy } from '../enrich-email-status';

export type StepKind = 'enrichment' | 'ai' | 'http' | 'formula' | 'lookup';
export const STEP_KINDS: readonly StepKind[] = ['enrichment', 'ai', 'http', 'formula', 'lookup'];

// What the user picked for each kind (recall, reruns and auto-run rebuild from these).
export interface EnrichmentChoices {
  kind: 'enrichment';
  toolId: string;
  // tool input name → waterfall input key, or a fixed value
  inputs: Record<string, string | { value: string }>;
  providerOrder: string[];
  skipProviders: string[];
  stopAtFirst: boolean;
  valuePath: string | null;        // null: the result type's default field of the tool
  maxCostUsd: number | null;       // null: the tool's default cap
}
export interface AiChoices { kind: 'ai'; prompt: string; model: string | null; webSearch: boolean }
export interface HttpChoices {
  kind: 'http'; method: string; url: string; headers: Record<string, string>; body: string | null;
  valuePath: string; retries: number | null;
}
export interface FormulaChoices { kind: 'formula'; formula: string }
export interface LookupChoices {
  kind: 'lookup'; sheetId: string; matchColumn: string; mode: 'equals' | 'contains'; inputKey: string;
  returnColumn: string;
}
export type StepChoices = EnrichmentChoices | AiChoices | HttpChoices | FormulaChoices | LookupChoices;

// Frozen at start.
export interface BuiltEnrichment {
  kind: 'enrichment';
  toolName: string;
  toolKind: 'waterfall' | 'single';
  toolSnapshot: RequestTool;
  route: EnrichRoute;
  providerNames: Record<string, string>;
  capUsd: number | null;           // sent as X-Treg-Route-Max-Cost; null: unpriced (the provider bills)
  valuePath: string;
  cleanDomains: boolean;
}
export interface BuiltAi {
  kind: 'ai';
  model: string;
  search: SearchToolConfig | null; // planned at start as the AI column plans it (lib/web-search-plan.ts)
  capUsd: number;                  // one call's ceiling (input + max output tokens + web fees)
  lowUsd: number;                  // one call, typical
  highUsd: number;
}
export interface BuiltHttp { kind: 'http'; retries: number | null }
export interface BuiltFormula { kind: 'formula'; compiled: CompiledFormula }   // {{input_key}} refs
export interface BuiltLookup { kind: 'lookup' }
export type BuiltStep = BuiltEnrichment | BuiltAi | BuiltHttp | BuiltFormula | BuiltLookup;

// A check after a step that found a value: treg's email verify (accepted by
// strategy, lib/enrich-email-status.ts) or a formula over {{value}} and the
// inputs (a truthy result passes). A value that fails is rejected and the
// waterfall goes on.
export type CheckChoices = { kind: 'verify'; accept: EmailStrategy } | { kind: 'formula'; formula: string };
export interface BuiltVerifyCheck {
  kind: 'verify';
  tool: RequestTool;
  toolKind: 'waterfall' | 'single';
  exclude: string[];
  providerNames: Record<string, string>;
  capUsd: number | null;           // one check's ceiling; null: unpriced
}
export interface BuiltFormulaCheck { kind: 'formula'; compiled: CompiledFormula }
export interface StepCheck { choices: CheckChoices; built: BuiltVerifyCheck | BuiltFormulaCheck }

export interface WaterfallStep {
  id: string;                      // 's' + 6 characters, kept across edits
  label: string;                   // unique in the waterfall; what "answered by" shows
  on: boolean;
  requires: string[][];            // alternatives of input keys ([]: none needed)
  choices: StepChoices;
  built: BuiltStep;
  check?: StepCheck | null;
}

export interface WaterfallDry {
  column: string;                  // the result column's name when it started (usage's label)
  only: string | null;             // a step id: test that step alone
}

export interface WaterfallBlock {
  v: 1;
  resultType: ResultType;
  phone?: PhoneResult;
  inputs: WaterfallInputDef[];
  steps: WaterfallStep[];
  hideStepColumns: boolean;
  maxCostPerRowUsd: number;        // every on step's cap: holds and the default run limit
  tregCapPerRowUsd: number;        // the treg part, for today's enrichment limit
  spendLimitUsd: number | null;    // the run's limit on treg + AI spend
  rows: { mode: EnrichRowsMode; status: EnrichRowsStatus; test: number | null };
  fresh: boolean;                  // "always call again": no reuse, no dry run answers
  noReuse?: boolean;               // this run only ("Rerun this row")
  dry?: WaterfallDry;              // a dry run: writes nothing to the sheet
}

export type WaterfallRunConfig = HTTPAPIConfig & { waterfall: WaterfallBlock };

export function isWaterfallConfig(config: unknown): config is WaterfallRunConfig {
  const w = (config as { waterfall?: unknown } | null)?.waterfall;
  return !!w && typeof w === 'object' && (w as { v?: unknown }).v === 1;
}

// A stored config string, read as a waterfall config or null.
export function waterfallConfigOf(raw: string | null | undefined): WaterfallRunConfig | null {
  try { const c = JSON.parse(raw ?? 'null'); return isWaterfallConfig(c) ? c : null; } catch { return null; }
}

export const ANSWERED_BY_PATH = '$.answered_by';
export const stepPath = (stepId: string): string => `$.steps.${stepId}`;
export const STEP_ID_PATTERN = /^s[a-z0-9]{6}$/;
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

// A new step's id, not one of `taken`.
export function newStepId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `s${[...randomBytes(6)].map(b => ID_CHARS[b % ID_CHARS.length]).join('')}`;
    if (!taken.has(id)) return id;
  }
}

// The step a mapping's path names, or null.
export function stepIdOfPath(path: string): string | null {
  const m = /^\$\.steps\.(s[a-z0-9]{6})$/.exec(path);
  return m ? m[1] : null;
}

// The run's column for each step, and the answered-by column (null: none).
export function waterfallColumns(config: WaterfallRunConfig): {
  answeredBy: string | null; steps: Record<string, string>;
} {
  const steps: Record<string, string> = {};
  let answeredBy: string | null = null;
  for (const m of config.responseMapping ?? []) {
    if (m.jsonPath === ANSWERED_BY_PATH) answeredBy = m.columnName;
    const id = stepIdOfPath(m.jsonPath);
    if (id) steps[id] = m.columnName;
  }
  return { answeredBy, steps };
}

export const onSteps = (w: WaterfallBlock): WaterfallStep[] => w.steps.filter(s => s.on);

// The steps a row walks: the on steps in order, or a dry run's one step.
export function rowSteps(config: WaterfallRunConfig): WaterfallStep[] {
  const w = config.waterfall;
  const only = w.dry?.only ?? null;
  return only ? w.steps.filter(s => s.id === only) : w.steps.filter(s => s.on);
}

// treg's provider ids → the names a run shows, over every enrichment step.
export function providerNamesFrom(steps: readonly WaterfallStep[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of steps) {
    if (s.built.kind === 'enrichment') Object.assign(out, s.built.providerNames);
    if (s.check?.built.kind === 'verify') Object.assign(out, s.check.built.providerNames);
  }
  return out;
}

// An HTTP step's request, as lib/http-request.ts sends it.
export function stepRequestConfig(c: HttpChoices): HTTPRequestConfig {
  return {
    method: c.method.toUpperCase() as HTTPRequestConfig['method'], url: c.url, headers: { ...c.headers },
    ...(c.body ? { body: c.body } : {}),
  };
}

// Every request a run's config can send: its own requestConfig and, for a
// waterfall, each HTTP step's. The 'secrets'-scope scans read them all
// (lib/http-secrets-scan.ts): a step's /saved_key is as real as a column's.
export function requestConfigsOfRun(config: unknown): HTTPRequestConfig[] {
  const own = (config as { requestConfig?: HTTPRequestConfig } | null)?.requestConfig;
  const out: HTTPRequestConfig[] = own && typeof own === 'object' ? [own] : [];
  if (isWaterfallConfig(config)) {
    for (const s of config.waterfall.steps ?? []) {
      if (s?.choices?.kind === 'http') out.push(stepRequestConfig(s.choices));
    }
  }
  return out;
}
