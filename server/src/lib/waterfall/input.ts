// The start request of a waterfall column (the app's drawer; MCP and /api/v1
// convert their snake_case arguments to it), parsed strictly (pure): it can
// spend money, so a key Cubex doesn't know is refused at every level, never
// dropped, and every value is checked for type and size.
import {
  ENRICH_DAILY_LIMIT_MAX_USD, ENRICH_TEST_ROWS, MAX_COLUMNS_PER_SHEET, WATERFALL_DRY_MAX_ROWS,
  WATERFALL_LABEL_MAX_CHARS, WATERFALL_MAX_INPUTS,
} from '../constants';
import { strayKey } from '../enrich-agent-args';
import { concurrencyOf, CONCURRENCY_ERROR, MAX_SELECTED_ROWS } from '../enrich-run-input';
import { PHONE_FORMATS } from '../clean/cleaners';
import { isPhoneCountry } from '../clean/phone';
import { parseRuleField } from '../run-condition';
import type { EnrichRowsMode, EnrichRowsStatus } from '../enrich-run-config';
import { isResultType, type PhoneResult, type ResultType } from './result-type';
import { fixedValueProblem, INPUT_KEY_PATTERN, type InputSource } from './inputs';
import { parseSteps, type StepInput } from './input-steps';
import { STEP_ID_PATTERN } from './config';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const bad = (error: string): { error: string } => ({ error });

export interface WaterfallInputSpec { key: string; label: string; source: InputSource | null }

export interface WaterfallRunInput {
  columnName: string;
  continueColumn: boolean;         // run again on an existing waterfall column
  resultType: ResultType;
  phone: PhoneResult | null;
  inputs: WaterfallInputSpec[];
  steps: StepInput[];
  answeredBy: boolean;             // add (or keep) the "answered by" column
  hideStepColumns: boolean;
  rows: { mode: EnrichRowsMode; status: EnrichRowsStatus; test: number | null; rowIndexes: number[] | null };
  runIf: string | null;
  spendLimitUsd: number | null;
  concurrency: number | null;
  fresh: boolean;
  noReuse: boolean;
  rowGeneration: number | null;
  // A dry run (writes nothing): the rows (by id; none: the first rows that can
  // run) and, to test one step alone, its id.
  dry: { rowIds: string[] | null; only: string | null } | null;
}

const TOP = ['columnName', 'continueColumn', 'resultType', 'phone', 'inputs', 'steps', 'answeredBy',
  'hideStepColumns', 'rows', 'runIf', 'spendLimitUsd', 'concurrency', 'fresh', 'noReuse', 'rowGeneration', 'dry'];
const MODES = new Set(['all', 'filter', 'selected']);
const STATUSES = new Set(['any', 'not_enriched', 'no_result', 'failed']);

function parseInputs(v: unknown): { ok: WaterfallInputSpec[] } | { error: string } {
  if (!Array.isArray(v) || v.length > WATERFALL_MAX_INPUTS) {
    return bad(`inputs must be a list of at most ${WATERFALL_MAX_INPUTS} inputs.`);
  }
  const out: WaterfallInputSpec[] = [];
  for (const [i, raw] of v.entries()) {
    const where = `Input ${i + 1}`;
    if (!isObj(raw)) return bad(`${where} must be an object.`);
    const stray = strayKey(raw, ['key', 'label', 'source'], where);
    if (stray) return bad(stray);
    if (typeof raw.key !== 'string' || !INPUT_KEY_PATTERN.test(raw.key)) {
      return bad(`${where}: key must be lower case letters, digits and _ (such as first_name).`);
    }
    const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : raw.key;
    if (label.length > WATERFALL_LABEL_MAX_CHARS) return bad(`${where}: label is too long.`);
    let source: InputSource | null = null;
    const s = raw.source;
    if (isObj(s)) {
      const stray2 = strayKey(s, ['column', 'value'], `${where}.source`);
      if (stray2) return bad(stray2);
      if (typeof s.column === 'string' && s.column.trim() && s.column.length <= 200) {
        if (s.column.includes('}}')) return bad(`${where}: a column whose name holds "}}" can't be an input.`);
        source = { column: s.column };
      } else if (typeof s.value === 'string' && s.value.trim() && s.value.length <= 2_000) {
        const problem = fixedValueProblem(s.value);
        if (problem) return bad(`${where}: ${problem}`);
        source = { value: s.value.trim() };
      } else return bad(`${where}: source needs a column or a value.`);
    } else if (s !== undefined && s !== null) return bad(`${where}: source needs a column or a value.`);
    out.push({ key: raw.key, label, source });
  }
  if (new Set(out.map(i => i.key)).size !== out.length) return bad('Two inputs have the same key.');
  return { ok: out };
}

function parseRows(v: unknown): { ok: WaterfallRunInput['rows'] } | { error: string } {
  if (v === undefined || v === null) return { ok: { mode: 'all', status: 'any', test: null, rowIndexes: null } };
  if (!isObj(v)) return bad('rows must be an object.');
  const stray = strayKey(v, ['mode', 'status', 'test', 'rowIndexes'], 'rows');
  if (stray) return bad(stray);
  const mode = v.mode ?? 'all';
  if (typeof mode !== 'string' || !MODES.has(mode)) return bad('rows.mode is all, filter or selected.');
  const status = v.status ?? 'any';
  if (typeof status !== 'string' || !STATUSES.has(status)) {
    return bad('rows.status is any, not_enriched, no_result or failed.');
  }
  const test = v.test ?? null;
  const testOk = typeof test === 'number' && Number.isInteger(test) && test >= 1 && test <= ENRICH_TEST_ROWS * 20;
  if (test !== null && !testOk) {
    return bad('rows.test must be a whole number of rows.');
  }
  let rowIndexes: number[] | null = null;
  if (mode === 'selected') {
    const r = v.rowIndexes;
    if (!Array.isArray(r) || r.length === 0 || r.length > MAX_SELECTED_ROWS
      || !r.every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0)) {
      return bad('Selected rows need rows.rowIndexes.');
    }
    rowIndexes = [...new Set(r as number[])];
  }
  const rows = { mode: mode as EnrichRowsMode, status: status as EnrichRowsStatus, test: test as number | null };
  return { ok: { ...rows, rowIndexes } };
}

function parsePhone(v: unknown): { ok: PhoneResult | null } | { error: string } {
  if (v === undefined || v === null) return { ok: null };
  if (!isObj(v)) return bad('phone must be {format, country}.');
  const stray = strayKey(v, ['format', 'country'], 'phone');
  if (stray) return bad(stray);
  const format = v.format ?? 'international';
  if (!(PHONE_FORMATS as readonly unknown[]).includes(format)) {
    return bad(`phone.format is ${PHONE_FORMATS.join(', ')}.`);
  }
  const country = typeof v.country === 'string' ? v.country.trim().toUpperCase() : 'US';
  if (!isPhoneCountry(country)) return bad('phone.country must be a two-letter country code, such as US or GB.');
  return { ok: { format: format as PhoneResult['format'], country } };
}

function parseDry(v: unknown): { ok: WaterfallRunInput['dry'] } | { error: string } {
  if (v === undefined || v === null || v === false) return { ok: null };
  if (v === true) return { ok: { rowIds: null, only: null } };
  if (!isObj(v)) return bad('dry must be true or {rowIds, only}.');
  const stray = strayKey(v, ['rowIds', 'only'], 'dry');
  if (stray) return bad(stray);
  let rowIds: string[] | null = null;
  if (v.rowIds !== undefined && v.rowIds !== null) {
    if (!Array.isArray(v.rowIds) || v.rowIds.length === 0 || v.rowIds.length > WATERFALL_DRY_MAX_ROWS
      || !v.rowIds.every(id => typeof id === 'string' && id.length <= 64)) {
      return bad(`dry.rowIds lists 1 to ${WATERFALL_DRY_MAX_ROWS} row ids.`);
    }
    rowIds = [...new Set(v.rowIds as string[])];
  }
  if (v.only !== undefined && v.only !== null && (typeof v.only !== 'string' || !STEP_ID_PATTERN.test(v.only))) {
    return bad('dry.only is a step id.');
  }
  return { ok: { rowIds, only: (v.only as string | null | undefined) ?? null } };
}

export function parseWaterfallInput(body: unknown): { ok: WaterfallRunInput } | { error: string } {
  if (!isObj(body)) return bad('Send the waterfall as a JSON object.');
  const stray = strayKey(body, TOP, '');
  if (stray) return bad(`${stray} Nothing was started.`);
  if (typeof body.columnName !== 'string' || !body.columnName.trim() || body.columnName.length > 200) {
    return bad('columnName is required.');
  }
  if (!isResultType(body.resultType)) {
    return bad('resultType is email, phone, domain, linkedin_url, url or text.');
  }
  const phone = parsePhone(body.phone);
  if ('error' in phone) return phone;
  const inputs = parseInputs(body.inputs ?? []);
  if ('error' in inputs) return inputs;
  const steps = parseSteps(body.steps);
  if ('error' in steps) return steps;
  const rows = parseRows(body.rows);
  if ('error' in rows) return rows;
  const runIf = parseRuleField(body.runIf);
  if ('error' in runIf) return runIf;
  const limit = body.spendLimitUsd;
  if (limit !== undefined && limit !== null
    && !(typeof limit === 'number' && Number.isFinite(limit) && limit > 0 && limit <= ENRICH_DAILY_LIMIT_MAX_USD)) {
    return bad('spendLimitUsd must be more than 0.');
  }
  const concurrency = concurrencyOf(body.concurrency);
  if (concurrency === undefined) return bad(CONCURRENCY_ERROR);
  for (const k of ['continueColumn', 'answeredBy', 'hideStepColumns', 'fresh', 'noReuse'] as const) {
    if (body[k] !== undefined && typeof body[k] !== 'boolean') return bad(`${k} is true or false.`);
  }
  const gen = body.rowGeneration;
  if (gen !== undefined && gen !== null && !(typeof gen === 'number' && Number.isInteger(gen) && gen >= 0)) {
    return bad('rowGeneration must be a whole number.');
  }
  const dry = parseDry(body.dry);
  if ('error' in dry) return dry;
  if (inputs.ok.length + steps.ok.length + 2 > MAX_COLUMNS_PER_SHEET) return bad('Too many inputs and steps.');
  return {
    ok: {
      columnName: body.columnName.trim(), continueColumn: body.continueColumn === true, resultType: body.resultType,
      phone: phone.ok, inputs: inputs.ok, steps: steps.ok, answeredBy: body.answeredBy !== false,
      hideStepColumns: body.hideStepColumns !== false, rows: rows.ok, runIf: runIf.ok,
      spendLimitUsd: (limit as number | null | undefined) ?? null, concurrency, fresh: body.fresh === true,
      noReuse: body.noReuse === true, rowGeneration: (gen as number | null | undefined) ?? null, dry: dry.ok,
    },
  };
}
