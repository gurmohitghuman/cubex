// Inputs and outputs of a treg catalog tool, read from its catalog entry (pure).
// Single tools declare queryParams / body / pathParams; a waterfall
// (treg.<capability>) declares a JSON body plus its contract's identity sets
// (which inputs are enough together) and outputs under $.output.

export interface ToolInput {
  name: string;
  in: 'query' | 'body' | 'path';
  type: string;          // as treg declares it: string, integer, array[string], …
  required: boolean;
  note?: string;
  example?: unknown;
  enum?: unknown[];
  min?: number;
  max?: number;
  filter?: boolean;      // a waterfall filter (country, limit…) rather than an identity key
}

// required: the waterfall's contract always fills it on a hit (email for an
// email find), so setup selects it by default.
export interface ToolOutput { field: string; path: string; type?: string; note?: string; required?: boolean }
export interface ToolList { field: string; path: string }

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function fieldsOf(section: unknown, where: ToolInput['in'], filterNames?: Set<string>): ToolInput[] {
  if (!isObj(section)) return [];
  return Object.entries(section).filter(([, def]) => isObj(def)).map(([name, def]) => {
    const d = def as Json;
    const input: ToolInput = { name, in: where, type: typeof d.type === 'string' ? d.type : 'string', required: d.required === true };
    if (typeof d.note === 'string') input.note = d.note;
    if (d.example !== undefined) input.example = d.example;
    if (Array.isArray(d.enum)) input.enum = d.enum;
    const min = num(d.min) ?? num(d.minimum); const max = num(d.max) ?? num(d.maximum);
    if (min !== undefined) input.min = min;
    if (max !== undefined) input.max = max;
    if (filterNames?.has(name)) input.filter = true;
    return input;
  });
}

// identitySets: for a waterfall, the keys that make an identity; everything
// else in the body is a filter.
export function toolInputs(input: unknown, identitySets: string[][] | null): ToolInput[] {
  if (!isObj(input)) return [];
  const identityKeys = new Set((identitySets ?? []).flat());
  const filters = identitySets
    ? new Set(Object.keys(isObj(input.body) ? input.body : {}).filter(k => !identityKeys.has(k)))
    : undefined;
  return [
    ...fieldsOf(input.pathParams, 'path'),
    ...fieldsOf(input.queryParams, 'query'),
    ...fieldsOf(input.body, 'body', filters),
  ];
}

export function identitySetsOf(contract: unknown): string[][] | null {
  if (!isObj(contract) || !Array.isArray(contract.identity)) return null;
  const sets = contract.identity
    .filter((s): s is unknown[] => Array.isArray(s))
    .map(s => s.filter((k): k is string => typeof k === 'string'))
    .filter(s => s.length > 0);
  return sets.length ? sets : null;
}

// What treg derives from what the caller sent ({full_name: "join(first_name, last_name)"}),
// so a missing identity key that treg can fill in doesn't count as missing.
export function deriveOf(contract: unknown): Record<string, string> | null {
  if (!isObj(contract) || !isObj(contract.derive)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(contract.derive)) if (typeof v === 'string') out[k] = v;
  return Object.keys(out).length ? out : null;
}

// A JSONPath segment Cubex's validator accepts (lib/jsonpath-extract.ts):
// .identifier, or ["quoted key"] for anything else.
export function pathSegment(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `["${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
}

// Waterfall outputs come from the contract: every field is $.output.<field>,
// and a list-typed field means the tool returns rows (people, companies…).
export function contractOutputs(contract: unknown): { outputs: ToolOutput[]; list: ToolList | null } {
  const outputs: ToolOutput[] = [];
  let list: ToolList | null = null;
  if (!isObj(contract) || !isObj(contract.output)) return { outputs, list };
  for (const [field, def] of Object.entries(contract.output)) {
    const d = isObj(def) ? def : {};
    const path = `$.output${pathSegment(field)}`;
    const type = typeof d.type === 'string' ? d.type : undefined;
    if (type === 'list' && !list) { list = { field, path }; continue; }
    outputs.push({
      field, path, ...(type ? { type } : {}), ...(typeof d.note === 'string' ? { note: d.note } : {}),
      ...(d.required === true ? { required: true } : {}),
    });
  }
  return { outputs, list };
}

const MAX_EXAMPLE_OUTPUTS = 60;
const MAX_EXAMPLE_ARRAYS = 20;
const MAX_DEPTH = 4;

// Single tools: suggest the leaf fields of the catalog's example answer (first
// item of each array), and the first array of objects as a possible list.
// arrays: the lists that could hold results, empty ones too (a run may name
// one as its results, e.g. one the example shows empty:
// services/enrich-list-build.ts); never one inside another list's item.
export function exampleOutputs(example: unknown): { outputs: ToolOutput[]; list: ToolList | null; arrays: string[] } {
  const outputs: ToolOutput[] = [];
  const arrays: string[] = [];
  let list: ToolList | null = null;
  const walk = (value: unknown, path: string, label: string, depth: number) => {
    if (outputs.length >= MAX_EXAMPLE_OUTPUTS || depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
      const fits = value.length === 0 || isObj(value[0]);
      if (fits && !path.includes('[') && arrays.length < MAX_EXAMPLE_ARRAYS) arrays.push(path);
      if (!list && value.length > 0 && isObj(value[0])) list = { field: label || 'items', path };
      if (value.length > 0) walk(value[0], `${path}[0]`, label, depth + 1);
      return;
    }
    if (isObj(value)) {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}${pathSegment(k)}`, label ? `${label}.${k}` : k, depth + 1);
      return;
    }
    if (label) outputs.push({ field: label, path, type: value === null ? 'null' : typeof value });
  };
  walk(example, '$', '', 0);
  return { outputs, list, arrays };
}
