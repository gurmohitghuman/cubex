// Over 200 lines: each step kind's strict parse sits here together, a few lines each.
// A waterfall's steps as a start request sends them, parsed strictly (pure):
// every level refuses a key it doesn't know (a misspelling is never dropped),
// and every value has a type and a size. What a step means against the sheet
// and the catalog (a tool that exists, a model, inputs it maps) is checked
// when it's built (services/waterfall-build.ts).
import {
  HTTP_RETRY_MAX, TREG_TOOL_ID_PATTERN, ENRICH_ESTIMATE_MAX_LIST, ENRICH_MAX_ROW_CAP_USD,
  WATERFALL_HTTP_BODY_MAX_CHARS, WATERFALL_HTTP_HEADERS_MAX, WATERFALL_HTTP_URL_MAX_CHARS, WATERFALL_LABEL_MAX_CHARS,
  WATERFALL_MAX_ALTERNATIVES, WATERFALL_MAX_INPUTS, WATERFALL_MAX_STEPS, WATERFALL_PROMPT_MAX_CHARS,
} from '../constants';
import { strayKey } from '../enrich-agent-args';
import { STEP_ID_PATTERN, type CheckChoices, type StepChoices } from './config';
import { formulaText, parseCheck } from './input-check';
import { INPUT_KEY_PATTERN } from './inputs';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export interface StepInput {
  id: string | null;               // null: a new step (an id is made)
  label: string | null;            // null: named after its tool or kind
  on: boolean;
  requires: string[][] | null;     // null: what the step reads (or the tool's own rule)
  choices: StepChoices;
  check: CheckChoices | null;      // a check on the value it finds
}

export type Parsed<T> = { ok: T } | { error: string };
const bad = (error: string): { error: string } => ({ error });

function keys(v: unknown, name: string): Parsed<string[]> {
  if (v === undefined || v === null) return { ok: [] };
  if (!Array.isArray(v) || v.length > ENRICH_ESTIMATE_MAX_LIST
    || !v.every(s => typeof s === 'string' && PROVIDER_RE.test(s))) return bad(`${name} must be a list of names.`);
  return { ok: v as string[] };
}

export function parseRequires(v: unknown, where: string): Parsed<string[][] | null> {
  if (v === undefined || v === null) return { ok: null };
  const msg = `${where}: requires must be a list of alternatives, each a list of input keys.`;
  if (!Array.isArray(v) || v.length > WATERFALL_MAX_ALTERNATIVES) return bad(msg);
  const out: string[][] = [];
  for (const alt of v) {
    if (!Array.isArray(alt) || alt.length === 0 || alt.length > WATERFALL_MAX_INPUTS
      || !alt.every(k => typeof k === 'string' && INPUT_KEY_PATTERN.test(k))) return bad(msg);
    out.push([...new Set(alt as string[])]);
  }
  return { ok: out };
}

function enrichment(c: Json, where: string): Parsed<StepChoices> {
  const stray = strayKey(c, ['kind', 'toolId', 'inputs', 'providerOrder', 'skipProviders', 'stopAtFirst',
    'valuePath', 'maxCostUsd'], where);
  if (stray) return bad(stray);
  if (typeof c.toolId !== 'string' || !TREG_TOOL_ID_PATTERN.test(c.toolId)) {
    return bad(`${where}: toolId isn't a treg tool id.`);
  }
  const inputs: Record<string, string | { value: string }> = {};
  if (c.inputs !== undefined && c.inputs !== null) {
    if (!isObj(c.inputs)) return bad(`${where}: inputs must map the tool's inputs to input keys.`);
    for (const [name, src] of Object.entries(c.inputs)) {
      if (!PROVIDER_RE.test(name)) return bad(`${where}: "${name.slice(0, 40)}" isn't a tool input name.`);
      if (typeof src === 'string' && INPUT_KEY_PATTERN.test(src)) inputs[name] = src;
      else if (isObj(src) && typeof src.value === 'string' && Object.keys(src).length === 1
        && src.value.length <= 2_000) {
        inputs[name] = { value: src.value };
      } else return bad(`${where}: the tool input ${name} needs an input key or {"value": "..."}.`);
    }
  }
  const order = keys(c.providerOrder, `${where}: providerOrder`);
  if ('error' in order) return order;
  const skip = keys(c.skipProviders, `${where}: skipProviders`);
  if ('error' in skip) return skip;
  const cap = c.maxCostUsd;
  if (cap !== undefined && cap !== null
    && !(typeof cap === 'number' && Number.isFinite(cap) && cap > 0 && cap <= ENRICH_MAX_ROW_CAP_USD)) {
    return bad(`${where}: maxCostUsd must be more than 0 and at most ${ENRICH_MAX_ROW_CAP_USD}.`);
  }
  const path = c.valuePath;
  if (path !== undefined && path !== null && (typeof path !== 'string' || path.length > 500)) {
    return bad(`${where}: valuePath must be a JSONPath.`);
  }
  if (c.stopAtFirst !== undefined && typeof c.stopAtFirst !== 'boolean') {
    return bad(`${where}: stopAtFirst is yes or no.`);
  }
  return {
    ok: {
      kind: 'enrichment', toolId: c.toolId, inputs, providerOrder: order.ok, skipProviders: skip.ok,
      stopAtFirst: c.stopAtFirst === true, valuePath: (c.valuePath as string | null | undefined) ?? null,
      maxCostUsd: (cap as number | null | undefined) ?? null,
    },
  };
}

function ai(c: Json, where: string): Parsed<StepChoices> {
  const stray = strayKey(c, ['kind', 'prompt', 'model', 'webSearch'], where);
  if (stray) return bad(stray);
  if (typeof c.prompt !== 'string' || !c.prompt.trim() || c.prompt.length > WATERFALL_PROMPT_MAX_CHARS) {
    return bad(`${where}: prompt is required (at most ${WATERFALL_PROMPT_MAX_CHARS} characters).`);
  }
  if (c.model !== undefined && c.model !== null && (typeof c.model !== 'string' || !MODEL_RE.test(c.model))) {
    return bad(`${where}: model isn't a model id.`);
  }
  if (c.webSearch !== undefined && typeof c.webSearch !== 'boolean') return bad(`${where}: webSearch is yes or no.`);
  const model = (c.model as string | null | undefined) ?? null;
  return { ok: { kind: 'ai', prompt: c.prompt, model, webSearch: c.webSearch === true } };
}

function http(c: Json, where: string): Parsed<StepChoices> {
  const stray = strayKey(c, ['kind', 'method', 'url', 'headers', 'body', 'valuePath', 'retries'], where);
  if (stray) return bad(stray);
  const method = typeof c.method === 'string' ? c.method.toUpperCase() : 'GET';
  if (!METHODS.has(method)) return bad(`${where}: method must be GET, POST, PUT or DELETE.`);
  if (typeof c.url !== 'string' || !c.url.trim() || c.url.length > WATERFALL_HTTP_URL_MAX_CHARS) {
    return bad(`${where}: url is required.`);
  }
  const headers: Record<string, string> = {};
  if (c.headers !== undefined && c.headers !== null) {
    if (!isObj(c.headers) || Object.keys(c.headers).length > WATERFALL_HTTP_HEADERS_MAX) {
      return bad(`${where}: headers must be an object of names and values.`);
    }
    for (const [h, v] of Object.entries(c.headers)) {
      if (!h.trim() || h.length > 200 || typeof v !== 'string' || v.length > 4_000) {
        return bad(`${where}: header "${h.slice(0, 40)}" needs a text value.`);
      }
      headers[h] = v;
    }
  }
  const body = c.body === undefined || c.body === null || c.body === '' ? null : c.body;
  if (body !== null && (typeof body !== 'string' || body.length > WATERFALL_HTTP_BODY_MAX_CHARS)) {
    return bad(`${where}: body must be text (at most ${WATERFALL_HTTP_BODY_MAX_CHARS} characters).`);
  }
  if (typeof c.valuePath !== 'string' || !c.valuePath.trim() || c.valuePath.length > 500) {
    return bad(`${where}: valuePath is required (the JSONPath of the value in the response, such as $.email).`);
  }
  const retries = c.retries;
  if (retries !== undefined && retries !== null
    && !(typeof retries === 'number' && Number.isInteger(retries) && retries >= 0 && retries <= HTTP_RETRY_MAX)) {
    return bad(`${where}: retries must be a whole number from 0 to ${HTTP_RETRY_MAX}.`);
  }
  return {
    ok: {
      kind: 'http', method, url: c.url.trim(), headers, body: body as string | null, valuePath: c.valuePath.trim(),
      retries: (retries as number | null | undefined) ?? null,
    },
  };
}

function formula(c: Json, where: string): Parsed<StepChoices> {
  const stray = strayKey(c, ['kind', 'formula'], where);
  if (stray) return bad(stray);
  const text = formulaText(c.formula, where);
  return 'error' in text ? text : { ok: { kind: 'formula', formula: text.ok } };
}

// Another sheet's column matched against one input; the value is the return column of the first match.
function lookup(c: Json, where: string): Parsed<StepChoices> {
  const stray = strayKey(c, ['kind', 'sheetId', 'matchColumn', 'mode', 'inputKey', 'returnColumn'], where);
  if (stray) return bad(stray);
  const name = (v: unknown) => typeof v === 'string' && !!v.trim() && v.length <= 200;
  if (!name(c.sheetId)) return bad(`${where}: sheetId is the sheet to look in.`);
  if (!name(c.matchColumn) || !name(c.returnColumn)) {
    return bad(`${where}: matchColumn and returnColumn name columns of the sheet it looks in.`);
  }
  const mode = c.mode ?? 'equals';
  if (mode !== 'equals' && mode !== 'contains') return bad(`${where}: mode is equals or contains.`);
  if (typeof c.inputKey !== 'string' || !INPUT_KEY_PATTERN.test(c.inputKey)) {
    return bad(`${where}: inputKey is the input whose value it looks for.`);
  }
  return {
    ok: {
      kind: 'lookup', sheetId: (c.sheetId as string).trim(), matchColumn: c.matchColumn as string, mode,
      inputKey: c.inputKey, returnColumn: c.returnColumn as string,
    },
  };
}

const KINDS: Record<string, (c: Json, where: string) => Parsed<StepChoices>> = {
  enrichment, ai, http, formula, lookup,
};

export function parseStep(v: unknown, i: number): Parsed<StepInput> {
  const where = `Step ${i + 1}`;
  if (!isObj(v)) return bad(`${where} must be an object.`);
  const stray = strayKey(v, ['id', 'label', 'on', 'requires', 'choices', 'check'], where);
  if (stray) return bad(stray);
  if (v.id !== undefined && v.id !== null && (typeof v.id !== 'string' || !STEP_ID_PATTERN.test(v.id))) {
    return bad(`${where}: id isn't a step id.`);
  }
  if (v.label !== undefined && v.label !== null
    && (typeof v.label !== 'string' || v.label.trim().length > WATERFALL_LABEL_MAX_CHARS)) {
    return bad(`${where}: label is at most ${WATERFALL_LABEL_MAX_CHARS} characters.`);
  }
  if (v.on !== undefined && typeof v.on !== 'boolean') return bad(`${where}: on is yes or no.`);
  const requires = parseRequires(v.requires, where);
  if ('error' in requires) return requires;
  const c = v.choices;
  if (!isObj(c) || typeof c.kind !== 'string') return bad(`${where}: choices.kind is required.`);
  const kind = KINDS[c.kind];
  if (!kind) return bad(`${where}: a step is an enrichment, ai, http, formula or lookup step.`);
  const choices = kind(c, where);
  if ('error' in choices) return choices;
  const check = parseCheck(v.check, where);
  if ('error' in check) return check;
  const label = typeof v.label === 'string' && v.label.trim() ? v.label.trim() : null;
  const id = (v.id as string | null | undefined) ?? null;
  return { ok: { id, label, on: v.on !== false, requires: requires.ok, choices: choices.ok, check: check.ok } };
}

export function parseSteps(v: unknown): Parsed<StepInput[]> {
  if (!Array.isArray(v) || v.length === 0) return bad('A waterfall needs at least one step.');
  if (v.length > WATERFALL_MAX_STEPS) return bad(`A waterfall has at most ${WATERFALL_MAX_STEPS} steps.`);
  const out: StepInput[] = [];
  for (let i = 0; i < v.length; i++) {
    const s = parseStep(v[i], i);
    if ('error' in s) return s;
    out.push(s.ok);
  }
  const ids = out.map(s => s.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) return bad('Two steps have the same id.');
  return { ok: out };
}
