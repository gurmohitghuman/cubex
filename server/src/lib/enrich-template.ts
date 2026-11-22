// An enrichment input's template, filled from one row (pure). Most are text:
// "{{Column}}" or a fixed value, with each {{Column}} replaced by the cell.
//
// A template laid out as JSON, a list or an object whose strings read columns
// (such as [{"country": "{{Country}}", "city": "{{Place}}"}]), is filled one
// string at a time, so a cell is never spliced into JSON text. In a list, a
// string that reads one column stands for each item of that cell (split on
// commas), with the text around it kept: "-{{Left out}}" sends "-intern" and
// "-senior" for "intern, senior", and an item that already starts with the
// "-" keeps one. A string whose columns are all empty is left out, so is an
// object or a list left empty, and an input left empty isn't sent. Only Cubex
// writes such templates (a fixed value can't hold "{{"), so a text template
// that happens to start with "[" is filled as text, as before.
import { normalizeColumnName } from './prompt';
import { cellOf } from './row-cell';

// [^{}], not [^}]: a long run of "{" would make every match scan to the end.
const TOKEN_RE = /\{\{([^{}]+)\}\}/g;

// The sheet's column a token names: an exact (case-insensitive) name wins over a normalized match.
function columnOf(token: string, columns: string[]): string | undefined {
  const name = token.trim();
  const lower = name.toLowerCase();
  const norm = normalizeColumnName(name);
  return columns.find(c => c.toLowerCase() === lower) ?? columns.find(c => normalizeColumnName(c) === norm);
}

// {{Column}} → that column's value in the row. `columns` is the sheet's column
// registry (column_order): stored rows are sparse, so a column the row lacks is
// an empty cell, and only a name missing from the registry is unknown.
export function fillTemplate(
  template: string, row: Record<string, string>, columns: string[],
): { value: string } | { unknown: string } {
  const miss: { name: string | null } = { name: null };
  const value = template.replace(TOKEN_RE, (_full, inner) => {
    const col = columnOf(String(inner), columns);
    if (col === undefined) { miss.name ??= String(inner).trim(); return ''; }
    return cellOf(row, col);
  });
  return miss.name !== null ? { unknown: miss.name } : { value };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// A JSON list or object with at least one {{Column}} in it.
export function jsonTemplateOf(template: string): unknown[] | Record<string, unknown> | null {
  const t = template.trim();
  if (!(t.startsWith('[') || t.startsWith('{')) || !t.includes('{{')) return null;
  try {
    const parsed: unknown = JSON.parse(t);
    return Array.isArray(parsed) || isObj(parsed) ? parsed : null;
  } catch { return null; }
}

// The columns a JSON template names, in order, once each (as written: a run resolves them as fillTemplate does).
export function jsonTemplateColumns(template: string): string[] {
  const json = jsonTemplateOf(template);
  if (!json) return [];
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (typeof n === 'string') {
      for (const t of n.matchAll(TOKEN_RE)) if (!out.includes(t[1].trim())) out.push(t[1].trim());
    } else if (Array.isArray(n)) n.forEach(walk);
    else if (isObj(n)) Object.values(n).forEach(walk);
  };
  walk(json);
  return out;
}

class UnknownColumn { constructor(readonly name: string) {} }

// One string of the template: its tokens filled, or (in a list, one token) one string per item of the cell.
function fillString(s: string, inList: boolean, row: Record<string, string>, columns: string[]): string[] {
  const tokens = [...s.matchAll(TOKEN_RE)];
  if (tokens.length === 0) return [s];
  const cells = tokens.map(t => {
    const col = columnOf(t[1], columns);
    if (col === undefined) throw new UnknownColumn(t[1].trim());
    return cellOf(row, col).trim();
  });
  if (cells.every(c => !c)) return [];
  if (inList && tokens.length === 1) {
    const at = tokens[0].index!;
    const before = s.slice(0, at).trimStart();
    const after = s.slice(at + tokens[0][0].length).trimEnd();
    return cells[0].split(',').map(x => x.trim()).filter(Boolean)
      .map(x => `${before && x.startsWith(before) ? '' : before}${x}${after && x.endsWith(after) ? '' : after}`);
  }
  let i = 0;
  const filled = s.replace(TOKEN_RE, () => cells[i++]).trim();
  return filled ? [filled] : [];
}

function fillNode(node: unknown, inList: boolean, row: Record<string, string>, columns: string[]): unknown[] {
  if (typeof node === 'string') return fillString(node, inList, row, columns);
  if (Array.isArray(node)) {
    const items = node.flatMap(n => fillNode(n, true, row, columns));
    return items.length ? [items] : [];
  }
  if (isObj(node)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      const filled = fillNode(v, false, row, columns);
      if (filled.length) out[k] = filled[0];
    }
    return Object.keys(out).length ? [out] : [];
  }
  return [node];
}

// The input's value for this row (undefined: nothing to send), or the column it names that the sheet lacks.
export function fillJsonTemplate(
  template: unknown[] | Record<string, unknown>, row: Record<string, string>, columns: string[],
): { value: unknown } | { unknown: string } {
  try {
    return { value: fillNode(template, false, row, columns)[0] };
  } catch (e) {
    if (e instanceof UnknownColumn) return { unknown: e.name };
    throw e;
  }
}
