// The run-start request from the drawer (and later MCP and /api/v1), parsed
// strictly (pure): it spends money, so anything unexpected is refused with a
// plain reason instead of being guessed at.
import {
  TREG_TOOL_ID_PATTERN, ENRICH_ESTIMATE_MAX_LIST, ENRICH_MAX_ROW_CAP_USD, ENRICH_DAILY_LIMIT_MAX_USD,
  MAX_COLUMNS_PER_SHEET, ENRICH_TEST_ROWS,
} from './constants';
import { GUESS_PATTERNS } from './enrich-email-guess';
import type { EmailStrategy } from './enrich-email-status';
import type { EnrichCondition, EnrichRowsMode } from './enrich-run-config';

export type InputBinding = { column: string } | { value: string };
export interface OutputInput { key: string; path: string | null; columnName: string }

export interface EnrichRunInput {
  toolId: string;
  preset: 'verified_email' | null;
  columnName: string;
  continueColumn: boolean;   // add to an existing enrichment column (rows not enriched yet)
  inputs: Record<string, InputBinding>;
  cleanDomains: boolean;
  providerOrder: string[]; skipProviders: string[]; stopAtFirst: boolean;
  email: { accept: EmailStrategy; guess: boolean; pattern: string } | null;
  outputs: OutputInput[];
  rows: { mode: EnrichRowsMode; test: number | null; rowIndexes: number[] | null };
  conditions: EnrichCondition[];
  maxCostPerRowUsd: number | null;
  spendLimitUsd: number | null;
  fresh: boolean;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_NAME = 200;
const MAX_FIXED = 2000;
const MAX_CONDITIONS = 20;
const MAX_SELECTED = 50_000;
const OPS = new Set(['not_empty', 'empty', 'eq', 'neq', 'contains', 'gt', 'lt']);
const MODES = new Set(['all', 'filter', 'selected', 'not_enriched']);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = MAX_NAME): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const names = (v: unknown): string[] | null =>
  (v === undefined ? [] : Array.isArray(v) && v.length <= ENRICH_ESTIMATE_MAX_LIST && v.every(s => typeof s === 'string' && NAME_RE.test(s)) ? v as string[] : null);
const usd = (v: unknown, max: number): number | null | undefined =>
  (v === undefined || v === null ? null : typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v : undefined);

function parseInputs(v: unknown): Record<string, InputBinding> | string {
  if (!isObj(v)) return 'inputs must map input names to a column or a fixed value.';
  const out: Record<string, InputBinding> = {};
  for (const [name, b] of Object.entries(v)) {
    if (!NAME_RE.test(name) || !isObj(b)) return `Input "${name.slice(0, 40)}" isn't valid.`;
    const column = str(b.column), value = str(b.value, MAX_FIXED);
    if (column !== null && column.trim()) out[name] = { column };
    else if (value !== null && value.trim()) {
      if (value.includes('{{')) return `The fixed value for ${name} can't contain "{{".`;
      out[name] = { value: value.trim() };
    } else return `Input ${name} needs a column or a value.`;
  }
  return out;
}

function parseOutputs(v: unknown): OutputInput[] | string {
  if (!Array.isArray(v) || v.length > MAX_COLUMNS_PER_SHEET) return 'outputs must be a list.';
  const out: OutputInput[] = [];
  for (const o of v) {
    const key = isObj(o) ? str(o.key) : null, columnName = isObj(o) ? str(o.columnName) : null;
    const path = isObj(o) && o.path !== null && o.path !== undefined ? str(o.path, 500) : null;
    if (!key || !columnName || (isObj(o) && o.path !== null && o.path !== undefined && path === null)) return 'Each output needs a key and a column name.';
    out.push({ key, path, columnName });
  }
  return out;
}

function parseConditions(v: unknown): EnrichCondition[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_CONDITIONS) return `Use at most ${MAX_CONDITIONS} conditions.`;
  const out: EnrichCondition[] = [];
  for (const c of v) {
    const column = isObj(c) ? str(c.column) : null, op = isObj(c) ? c.op : null, value = isObj(c) ? str(c.value ?? '', MAX_FIXED) : null;
    if (column === null || typeof op !== 'string' || !OPS.has(op) || value === null) return 'Each condition needs a column, an operator and a value.';
    out.push({ column, op: op as EnrichCondition['op'], value });
  }
  return out;
}

export function parseEnrichRunInput(body: unknown): { ok: EnrichRunInput } | { error: string } {
  const b = isObj(body) ? body : {};
  if (typeof b.toolId !== 'string' || !TREG_TOOL_ID_PATTERN.test(b.toolId)) return { error: 'Pick a tool first.' };
  if (b.preset !== undefined && b.preset !== null && b.preset !== 'verified_email') return { error: 'Unknown preset.' };
  const columnName = str(b.columnName);
  if (!columnName || !columnName.trim()) return { error: 'Add a column name.' };
  const inputs = parseInputs(b.inputs);
  if (typeof inputs === 'string') return { error: inputs };
  const order = names(b.providerOrder), skip = names(b.skipProviders);
  if (!order || !skip) return { error: 'providerOrder and skipProviders must be lists of provider names.' };
  const outputs = parseOutputs(b.outputs);
  if (typeof outputs === 'string') return { error: outputs };
  const conditions = parseConditions(b.conditions);
  if (typeof conditions === 'string') return { error: conditions };
  const rows = isObj(b.rows) ? b.rows : {};
  const mode = typeof rows.mode === 'string' && MODES.has(rows.mode) ? rows.mode as EnrichRowsMode : null;
  if (!mode) return { error: 'rows.mode must be all, filter, selected or not_enriched.' };
  const test = rows.test === true ? ENRICH_TEST_ROWS : null;
  let rowIndexes: number[] | null = null;
  if (mode === 'selected') {
    const ri = rows.rowIndexes;
    if (!Array.isArray(ri) || ri.length === 0 || ri.length > MAX_SELECTED || !ri.every(n => Number.isSafeInteger(n) && n >= 0)) {
      return { error: `Selected rows must be 1 to ${MAX_SELECTED.toLocaleString('en-US')} row numbers.` };
    }
    rowIndexes = [...new Set(ri as number[])].sort((x, y) => x - y);
  }
  const cap = usd(b.maxCostPerRowUsd, ENRICH_MAX_ROW_CAP_USD);
  if (cap === undefined) return { error: `Max per row must be more than $0 and at most $${ENRICH_MAX_ROW_CAP_USD.toLocaleString('en-US')}.` };
  const limit = usd(b.spendLimitUsd, ENRICH_DAILY_LIMIT_MAX_USD);
  if (limit === undefined) return { error: 'The run limit must be more than $0.' };
  let email: EnrichRunInput['email'] = null;
  if (b.preset === 'verified_email') {
    const e = isObj(b.email) ? b.email : {};
    const accept = e.accept === 'balanced' || e.accept === 'wide' ? e.accept : e.accept === undefined || e.accept === 'safest' ? 'safest' : null;
    const pattern = e.pattern === undefined ? 'first.last' : e.pattern;
    if (!accept || typeof pattern !== 'string' || !(GUESS_PATTERNS as readonly string[]).includes(pattern)) return { error: 'Check the email settings.' };
    email = { accept, guess: e.guess !== false, pattern };
  }
  return {
    ok: {
      toolId: b.toolId, preset: b.preset === 'verified_email' ? 'verified_email' : null,
      columnName: columnName.trim(), continueColumn: b.continueColumn === true, inputs,
      cleanDomains: b.cleanDomains !== false, providerOrder: order, skipProviders: skip, stopAtFirst: b.stopAtFirst === true,
      email, outputs, rows: { mode, test, rowIndexes }, conditions,
      maxCostPerRowUsd: cap, spendLimitUsd: limit, fresh: b.fresh === true,
    },
  };
}
