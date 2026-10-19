// One column rename inside a stored HTTP run config (pure): the fields it
// picks into columns, its request's {{column}} and /column references, its
// "Only run if" rule, an enrichment's older condition list and a list job's
// copied columns. Mutates `config`; true when anything changed. Used by the
// run records (lib/http-columns.ts) and by setup versions
// (lib/setup-versions/rename.ts). Strict (case-sensitive) equality: a rename
// only rewrites the exact stored name.
import { renameRuleColumn } from './run-condition';
import { renameTemplateColumnRefs } from './column-ref-rename';

export function renameHttpConfigColumn(config: any, oldName: string, newName: string): boolean {
  let changed = false;
  const mappings = config?.responseMapping;
  if (Array.isArray(mappings)) {
    for (const m of mappings) {
      if (m && m.columnName === oldName) { m.columnName = newName; changed = true; }
    }
  }
  // The request's {{column}} and /column references follow the rename too, or
  // a re-run sends "[MISSING: ...]" and overwrites good results with failures.
  const rc = config?.requestConfig;
  const rewrite = (v: unknown) => (typeof v === 'string' ? renameTemplateColumnRefs(v, oldName, newName) : v);
  if (rc && typeof rc === 'object') {
    for (const key of ['url', 'body'] as const) {
      const next = rewrite(rc[key]);
      if (next !== rc[key]) { rc[key] = next; changed = true; }
    }
    if (rc.headers && typeof rc.headers === 'object') {
      // Header names are templated too (makeHTTPRequest substitutes both).
      const headers: Record<string, unknown> = {};
      for (const [h, v] of Object.entries(rc.headers)) {
        const name = rewrite(h) as string;
        const value = rewrite(v);
        if (name !== h || value !== v) changed = true;
        headers[name] = value;
      }
      rc.headers = headers;
    }
  }
  // "Only run if" names columns too (the rule, and an enrichment's older
  // condition list), and so do a list job's copied columns (read from this sheet).
  if (typeof config?.runIf === 'string') {
    const runIf = renameRuleColumn(config.runIf, oldName, newName);
    if (runIf !== config.runIf) { config.runIf = runIf; changed = true; }
  }
  const where = config?.enrichment?.rows?.where;
  if (Array.isArray(where)) {
    for (const c of where) if (c && c.column === oldName) { c.column = newName; changed = true; }
  }
  const copy = config?.enrichment?.list?.copy;
  if (Array.isArray(copy)) {
    for (const c of copy) if (c && c.from === oldName) { c.from = newName; changed = true; }
  }
  return changed;
}
