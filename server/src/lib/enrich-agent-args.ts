// Arguments agents send (MCP and /api/v1) checked for names Cubex doesn't
// know (pure): a misspelled one is refused, never dropped, at every level, so
// "estimateOnly" can't start a paid run and "values" can't widen a filter.
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

// Every argument run_enrichment knows, and those of its parts. Anything else
// is refused: a misspelled estimate_only ("estimateOnly") silently dropped
// would start a paid run instead of estimating it.
const KNOWN: Record<string, string[]> = {
  '': ['sheet_id', 'tool_id', 'preset', 'column_name', 'add_to_column', 'inputs', 'clean_domains', 'outputs',
    'email', 'provider_order', 'skip_providers', 'stop_at_first', 'max_cost_per_row_usd', 'spend_limit_usd',
    'rows', 'use_sheet_filter', 'test', 'where', 'fresh', 'list', 'target_row_ids', 'estimate_only',
    'idempotency_key', 'auto_run'],
  list: ['destination_sheet_id', 'new_sheet_name', 'provider', 'results_per_row', 'fields', 'copy_columns',
    'dedupe_path'],
  email: ['accept', 'guess', 'pattern'],
  auto_run: ['enabled', 'daily_cap_usd'],
};
// The items of the lists (and the input bindings), checked the same way.
const ITEMS: Array<{ name: string; of: (a: Json) => unknown; keys: string[] }> = [
  { name: 'outputs[]', of: a => a.outputs, keys: ['field', 'column_name'] },
  { name: 'where[]', of: a => a.where, keys: ['column', 'operator', 'value'] },
  { name: 'list.fields[]', of: a => (isObj(a.list) ? a.list.fields : null), keys: ['path', 'column_name'] },
  { name: 'list.copy_columns[]', of: a => (isObj(a.list) ? a.list.copy_columns : null), keys: ['from', 'to'] },
  { name: 'inputs.<name>', of: a => (isObj(a.inputs) ? Object.values(a.inputs) : null), keys: ['column', 'value'] },
];
const snake = (k: string) => k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`).replace(/-/g, '_');

export function strayKey(obj: Json, known: string[], name: string): string | null {
  for (const key of Object.keys(obj)) {
    if (known.includes(key)) continue;
    const near = known.includes(snake(key)) ? ` (did you mean ${snake(key)}?)` : '';
    return `Unknown argument ${name ? `${name}.` : ''}${key}${near}.`;
  }
  return null;
}

export function unknownArgument(a: Record<string, unknown>): string | null {
  for (const [part, known] of Object.entries(KNOWN)) {
    const obj = part ? a[part] : a;
    const stray = isObj(obj) ? strayKey(obj, known, part) : null;
    if (stray) return `${stray} Nothing was started.`;
  }
  for (const item of ITEMS) {
    const list = item.of(a);
    for (const entry of Array.isArray(list) ? list : []) {
      const stray = isObj(entry) ? strayKey(entry, item.keys, item.name) : null;
      if (stray) return `${stray} Nothing was started.`;
    }
  }
  return null;
}
