// What a restored column's answer says about each reference the delete cleaned up (lib/trash/column-refs.ts):
// where it was, what it did, and how to set it up again, in the words of the surface asking (an MCP tool,
// a REST route, or the app). Pure.
import type { DroppedRef } from './column-refs';

export type RefSurface = 'mcp' | 'rest' | 'app';

export type DroppedEntry = DroppedRef & { where: string; did: string; redo: string };

const q = (s: string) => `"${s}"`;
const by = (s: RefSurface, words: { mcp: string; rest: string; app: string }) => words[s];
const MODE_WORDS = { http: 'HTTP API column', enrichment: 'enrichment', waterfall: 'waterfall' } as const;

// `name`: the name the column came back under; `old`: the one it had.
export function droppedEntry(ref: DroppedRef, name: string, old: string, s: RefSurface, sheetId: string):
  DroppedEntry {
  const sheetPath = `/api/v1/sheets/${sheetId}`;
  const w = (where: string, did: string, redo: string): DroppedEntry => ({ ...ref, where, did, redo });
  switch (ref.kind) {
    case 'view_hidden':
      return w(`view ${q(ref.view)}`, 'hid this column', by(s, {
        mcp: `manage_view with action "change", view ${q(ref.view)} and ${q(name)} in hidden_columns`,
        rest: `PATCH ${sheetPath}/views/${ref.view_id} with ${q(name)} in hidden_columns`,
        app: `Hide it again in the view ${q(ref.view)}.` }));
    case 'view_filter':
      return w(`view ${q(ref.view)}`, 'filtered rows on this column', by(s, {
        mcp: `manage_view with action "change", view ${q(ref.view)} and a where on ${q(name)}`,
        rest: `PATCH ${sheetPath}/views/${ref.view_id} with a where on ${q(name)}`,
        app: `Filter on it again in the view ${q(ref.view)}.` }));
    case 'sheet_filter':
      return w("the sheet's filter", 'filtered the rows the sheet shows on this column', by(s, {
        mcp: 'Filter on it again in the app, or keep the filter in a view with manage_view',
        rest: `Filter on it again in the app, or keep the filter in a view: POST ${sheetPath}/views`,
        app: 'Filter on it again from its column header.' }));
    case 'webhook_mapping':
      return w(`webhook ${q(ref.webhook)}`, `put the field ${ref.field} of each event in this column`,
        "Map the field to it again in the sheet's webhook settings (only in the app).");
    case 'http_field': {
      const field = ref.path ? `its field ${ref.path}` : 'a field';
      const tool = TOOL[ref.mode];
      return w(`column ${q(ref.column)}`, `the ${MODE_WORDS[ref.mode]} ${q(ref.column)} wrote ${field} here`, by(s, {
        mcp: `${tool.mcp} on ${q(ref.column)}, writing ${field} into ${q(name)}`,
        rest: `POST ${sheetPath}/${tool.rest} for ${q(ref.column)}, writing ${field} into ${q(name)}`,
        app: `Pick ${field} again in ${q(ref.column)}'s setup.` }));
    }
    case 'list_field':
      return w(`sheet ${q(ref.sheet)}, column ${q(ref.column)}`,
        `the list enrichment ${q(ref.column)} in ${q(ref.sheet)} put one of its fields in this column`, by(s, {
          mcp: `add_list_rows (sheet ${ref.sheet_id}, column ${q(ref.column)}) with a field into ${q(name)}`,
          rest: `POST /api/v1/sheets/${ref.sheet_id}/enrichment-list-fields with a field into ${q(name)}`,
          app: `Pick the field again in ${q(ref.column)}'s list settings in ${q(ref.sheet)}.` }));
    case 'ai_output':
      return w(`column ${q(ref.column)}`, `the AI column ${q(ref.column)} wrote one of its outputs here`, by(s, {
        mcp: `run_ai_column on ${q(ref.column)} with ${q(name)} in output_columns`,
        rest: `POST ${sheetPath}/ai-runs for ${q(ref.column)} with ${q(name)} in output_columns`,
        app: `Add it back as an output in ${q(ref.column)}'s AI setup.` }));
    case 'ai_data':
      return w(`column ${q(ref.column)}`, `the AI column ${q(ref.column)} wrote its web sources here`
        + (ref.search_off ? ' (web search on it was turned off)' : ''), by(s, {
        mcp: `run_ai_column on ${q(ref.column)} with web search on`,
        rest: `POST ${sheetPath}/ai-runs for ${q(ref.column)} with web search on`,
        app: `Turn web search on again in ${q(ref.column)}'s AI setup.` }));
    case 'auto_run':
      return w('auto-run', 'ran this column on new and changed rows by itself (it is off now)', by(s, {
        mcp: `set_auto_run on ${q(name)}`, rest: `PUT ${sheetPath}/enrichment-auto-run with column ${q(name)}`,
        app: 'Turn auto-run on again from its column menu.' }));
    case 'auto_run_input':
      return w(`column ${q(ref.column)}`, `the auto-run of ${q(ref.column)} reads ${q(old)}, and waits until a `
        + `column named ${q(old)} is back`, by(s, {
        mcp: `rename_column ${q(name)} to ${q(old)} once that name is free, or set ${q(ref.column)} up to read `
          + q(name),
        rest: `PATCH ${sheetPath}/columns/:name to rename ${q(name)} to ${q(old)} once that name is free, or set `
          + `${q(ref.column)} up to read ${q(name)}`,
        app: `Rename it back to ${q(old)} once that name is free, or set ${q(ref.column)} up to read ${q(name)}.` }));
    case 'lookup_into':
      return w(`sheet ${q(ref.sheet)}, column ${q(ref.column)}`, `the lookup column ${q(ref.column)} in `
        + `${q(ref.sheet)} ${ref.part === 'match' ? 'matched rows on' : 'returned'} this column, and stopped`, by(s, {
        mcp: `lookup_column on the sheet ${ref.sheet_id} to set ${q(ref.column)} up again with ${q(name)}`,
        rest: `POST /api/v1/sheets/${ref.sheet_id}/lookup-columns to set ${q(ref.column)} up again with ${q(name)}`,
        app: `Set ${q(ref.column)} up again in ${q(ref.sheet)}.` }));
    case 'auto_dedupe':
      return w('auto-dedupe', `kept one row per value of this column (the ${ref.keep}), and is off now`, by(s, {
        mcp: `set_auto_dedupe with column ${q(name)}`, rest: `PUT ${sheetPath}/auto-dedupe with column ${q(name)}`,
        app: 'Turn auto-dedupe on again from the sheet menu.' }));
    case 'undo':
      return w('undo_run', `undoing ${ref.runs === 1 ? 'the run' : `${ref.runs} runs`} that wrote this column no `
        + 'longer puts its cells back', 'Nothing to set up: those undos leave this column as it is.');
    case 'output_taken':
      return takenEntry(ref, name, s, sheetPath, w);
  }
}

const TOOL = {
  http: { mcp: 'run_http_enrichment', rest: 'http-runs' },
  enrichment: { mcp: 'add_enrichment_field', rest: 'enrichment-fields' },
  waterfall: { mcp: 'waterfall_column', rest: 'waterfall-columns' },
} as const;

// A column the restored column's own setup wrote, which another setup fills now: it stays with that one.
function takenEntry(ref: Extract<DroppedRef, { kind: 'output_taken' }>, name: string, s: RefSurface,
  sheetPath: string, w: (where: string, did: string, redo: string) => DroppedEntry): DroppedEntry {
  const what = ref.mode === 'ai' ? 'one of its outputs' : `its field ${ref.path ?? ''}`.trim();
  const did = `${q(name)} wrote ${what} here. ${q(ref.column)} ${ref.now}, so it stays with that setup and `
    + `${q(name)} came back without it`;
  const once = `once nothing else fills ${q(ref.column)}`;
  if (ref.mode === 'ai') {
    return w(`column ${q(ref.column)}`, did, by(s, {
      mcp: `run_ai_column on ${q(name)} with ${q(ref.column)} in output_columns, ${once}`,
      rest: `POST ${sheetPath}/ai-runs for ${q(name)} with ${q(ref.column)} in output_columns, ${once}`,
      app: `Add ${q(ref.column)} back as an output in ${q(name)}'s AI setup, ${once}.` }));
  }
  const tool = TOOL[ref.mode];
  return w(`column ${q(ref.column)}`, did, by(s, {
    mcp: `${tool.mcp} on ${q(name)}, writing ${what} into ${q(ref.column)}, ${once}`,
    rest: `POST ${sheetPath}/${tool.rest} for ${q(name)}, writing ${what} into ${q(ref.column)}, ${once}`,
    app: `Pick ${what} again in ${q(name)}'s setup, ${once}.` }));
}

// A paused auto-run of another column lifts by itself once a column named as before is back.
export const stillDropped = (ref: DroppedRef, renamed: boolean): boolean => ref.kind !== 'auto_run_input' || renamed;
