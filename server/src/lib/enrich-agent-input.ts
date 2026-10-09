// An agent's run_enrichment arguments (MCP and /api/v1, snake_case) as the
// drawer's run request (pure), so lib/enrich-run-input.ts parses both with
// the same strict rules. Outputs are named by the fields get_enrichment lists
// and looked up in the tool's catalog entry here; the run start checks them
// against treg's catalog again.
import type { EnrichTool } from './enrich-tool';
import { strayKey } from './enrich-agent-args';

export { unknownArgument } from './enrich-agent-args';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

export interface AgentRunArgs {
  tool_id?: unknown; preset?: unknown; column_name?: unknown; add_to_column?: unknown;
  inputs?: unknown; clean_domains?: unknown; outputs?: unknown; email?: unknown;
  provider_order?: unknown; skip_providers?: unknown; stop_at_first?: unknown;
  max_cost_per_row_usd?: unknown; spend_limit_usd?: unknown; rows?: unknown; use_sheet_filter?: unknown;
  test?: unknown; where?: unknown; fresh?: unknown; list?: unknown;
}

// Verified work email's columns (Cubex fills them; client enrich-modal/outputs.ts).
export const EMAIL_OUTPUTS: Record<string, string | null> = {
  email: '$.output.email', email_status: null, found_by: '$._treg.served_by', checked_by: null,
};
const EMAIL_DEFAULTS = [
  { key: 'email', columnName: 'Email' }, { key: 'email_status', columnName: 'Email status' },
  { key: 'found_by', columnName: 'Found by' },
];
// Who answered a waterfall, offered on every waterfall.
export const FOUND_BY_FIELD = 'found_by';

const OPERATORS: Record<string, string> = {
  eq: 'eq', neq: 'neq', contains: 'contains', empty: 'empty', not_empty: 'not_empty', gt: 'gt', lt: 'lt',
};

// The fields an agent can name in `outputs` for this tool (and preset).
export function outputFields(tool: EnrichTool, preset: string | null): string[] {
  if (preset === 'verified_email') return Object.keys(EMAIL_OUTPUTS);
  const fields = tool.outputs.map(o => o.field);
  return tool.kind === 'waterfall' ? [...fields, FOUND_BY_FIELD] : fields;
}

// true/false, or the text "true"/"false" (a REST client or an MCP client with a
// stale tool list). Anything else is refused: read as false, `test` would buy every row.
const FLAGS = ['add_to_column', 'clean_domains', 'stop_at_first', 'use_sheet_filter', 'test', 'fresh'] as const;
export function flagOf(v: unknown): boolean | undefined | 'invalid' {
  if (v === undefined) return undefined;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return 'invalid';
}

function inputsOf(v: unknown): Json | string {
  if (v === undefined) return {};
  if (!isObj(v)) return 'inputs must map each tool input to a column name, {"column": ...} or {"value": ...}.';
  const out: Json = {};
  for (const [name, b] of Object.entries(v)) out[name] = typeof b === 'string' ? { column: b } : b;
  return out;
}

function outputsOf(a: AgentRunArgs, tool: EnrichTool, preset: string | null): Json[] | string {
  if (isObj(a.list)) {
    return a.outputs === undefined ? [] : 'A job that adds rows has no outputs: pick its fields in list.fields.';
  }
  const fields = outputFields(tool, preset);
  if (a.outputs === undefined) {
    if (preset === 'verified_email') return EMAIL_DEFAULTS.map(d => ({ ...d, path: EMAIL_OUTPUTS[d.key] }));
    return `Pick the outputs: [{"field", "column_name"}]. This tool returns: ${fields.join(', ')}.`;
  }
  if (!Array.isArray(a.outputs)) return 'outputs must be a list of {field, column_name}.';
  const out: Json[] = [];
  for (const o of a.outputs) {
    const field = isObj(o) && typeof o.field === 'string' ? o.field : null;
    const columnName = isObj(o) ? o.column_name : null;
    if (!field || typeof columnName !== 'string') return 'Each output needs a field and a column_name.';
    if (!fields.includes(field)) return `This tool has no output "${field}". It returns: ${fields.join(', ')}.`;
    const path = preset === 'verified_email' ? EMAIL_OUTPUTS[field]
      : field === FOUND_BY_FIELD && tool.kind === 'waterfall' ? EMAIL_OUTPUTS.found_by
        : tool.outputs.find(t => t.field === field)?.path ?? null;
    out.push({ key: field, path, columnName });
  }
  return out;
}

// A condition's value is required where it decides (an empty "contains"
// would pass every row) and refused where it means nothing; a key it doesn't
// know ("values") is refused, never dropped.
export function agentConditions(v: unknown): Json[] | string {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return 'where must be a list of {column, operator, value}.';
  const out: Json[] = [];
  for (const c of v) {
    const op = isObj(c) && typeof c.operator === 'string' ? OPERATORS[c.operator] : undefined;
    if (!isObj(c) || !op) return `Each where condition needs an operator: ${Object.keys(OPERATORS).join(', ')}.`;
    const stray = strayKey(c, ['column', 'operator', 'value'], 'where[]');
    if (stray) return stray;
    const blankOp = op === 'empty' || op === 'not_empty';
    const value = c.value ?? '';
    if (typeof value !== 'string') return `The where value on ${String(c.column)} must be text.`;
    if (blankOp && value.trim()) return `where operator ${op} takes no value (on ${String(c.column)}).`;
    if (!blankOp && !value.trim()) return `where operator ${op} needs a value (on ${String(c.column)}).`;
    out.push({ column: c.column, op, value });
  }
  return out;
}

function listOf(v: unknown): Json | null | string {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) return 'list must say where the results go.';
  const destId = v.destination_sheet_id, newName = v.new_sheet_name;
  if ((destId === undefined) === (newName === undefined)) {
    return 'list needs one of destination_sheet_id (a sheet of this table) or new_sheet_name.';
  }
  const fields = v.fields === undefined || v.fields === null ? null : v.fields;
  if (fields !== null && !Array.isArray(fields)) return 'list.fields must be a list of {path, column_name}.';
  const copy = v.copy_columns === undefined ? [] : v.copy_columns;
  if (!Array.isArray(copy)) return 'list.copy_columns must be a list of {from, to}.';
  return {
    dest: destId !== undefined ? { sheetId: destId } : { newSheetName: newName },
    provider: v.provider ?? null, maxItems: v.results_per_row,
    fields: fields === null ? null : fields.map(f => (isObj(f) ? { path: f.path, columnName: f.column_name } : f)),
    copy: copy.map(c => (isObj(c) ? { from: c.from, to: c.to ?? c.from } : c)),
    dedupePath: v.dedupe_path ?? null,
  };
}

type Flags = Partial<Record<typeof FLAGS[number], boolean>>;

function rowsOf(a: AgentRunArgs, f: Flags, rowIndexes: number[] | null): Json {
  if (rowIndexes && f.use_sheet_filter) return { error: 'Use target_row_ids or use_sheet_filter, not both.' };
  const mode = rowIndexes ? 'selected' : f.use_sheet_filter ? 'filter' : 'all';
  return {
    mode, ...(a.rows === undefined ? {} : { status: a.rows }), test: f.test === true,
    ...(rowIndexes ? { rowIndexes } : {}),
  };
}

// The drawer's request body, or what's wrong with the arguments.
export function agentRunBody(
  a: AgentRunArgs, tool: EnrichTool, rowIndexes: number[] | null, rowGeneration: number | null,
): Json | { error: string } {
  const f: Flags = {};
  for (const name of FLAGS) {
    const v = flagOf(a[name]);
    if (v === 'invalid') return { error: `${name} must be true or false.` };
    if (v !== undefined) f[name] = v;
  }
  const preset = a.preset === undefined || a.preset === null ? null : a.preset;
  if (preset !== null && preset !== 'verified_email') return { error: 'preset must be verified_email.' };
  const inputs = inputsOf(a.inputs);
  if (typeof inputs === 'string') return { error: inputs };
  const outputs = outputsOf(a, tool, preset);
  if (typeof outputs === 'string') return { error: outputs };
  const conditions = agentConditions(a.where);
  if (typeof conditions === 'string') return { error: conditions };
  const list = listOf(a.list);
  if (typeof list === 'string') return { error: list };
  // The fields come from real results, so a job that adds rows starts with a test.
  if (list && list.fields === null && f.test !== true) {
    return {
      error: 'A job that adds rows needs the fields to keep, and they come from real results: run it with '
        + 'test: true first, then read the fields (get_list_fields) and pick them (add_list_rows).',
    };
  }
  if (a.email !== undefined && preset !== 'verified_email') return { error: 'email needs preset verified_email.' };
  const rows = rowsOf(a, f, rowIndexes);
  if (typeof rows.error === 'string') return { error: rows.error };
  const email = isObj(a.email) ? a.email : {};
  const guess = flagOf(email.guess);
  if (guess === 'invalid') return { error: 'email.guess must be true or false.' };
  return {
    toolId: tool.id, preset, columnName: a.column_name, continueColumn: f.add_to_column === true, inputs,
    cleanDomains: f.clean_domains !== false, providerOrder: a.provider_order, skipProviders: a.skip_providers,
    stopAtFirst: f.stop_at_first === true, outputs, rows, conditions,
    maxCostPerRowUsd: a.max_cost_per_row_usd, spendLimitUsd: a.spend_limit_usd, fresh: f.fresh === true,
    rowGeneration, list,
    ...(preset === 'verified_email'
      ? { email: { accept: email.accept, guess: guess ?? true, pattern: email.pattern } }
      : {}),
  };
}
