// read_rows' and REST rows/query's max_chars_per_cell (pure): each returned
// cell's text cut to its first N characters, and the cells cut listed with
// their full length. Characters are UTF-16 code units, the way String.length
// counts them and every cap in Cubex does (the cell limits, export_csv's
// 40,000); a cut that would end on the first half of a surrogate pair keeps one
// fewer, so no half of a pair comes back. An emoji built from several
// characters (a skin tone, a flag, a family) can still lose its last parts.
//
// Stored cells are text, a cell holding JSON included (cut like any text). A
// value a `columns` path takes out of a JSON cell can be a number, true, false
// or null (never cut) or an object or list: measured by its JSON text and, when
// that is longer, returned as that text cut (a string). A run cell read with
// include_status ({status, value, error}) has its text cut (value, error or
// reason: it holds at most one), never its status.

// The answer's cut_cells: row id → column → the full length of the text
// cut. Null-prototype objects, so any column name ("__proto__", "constructor")
// is a plain key; a row is there only when at least one of its cells was cut.
export type CellLengths = Record<string, number>;
export type CutCells = Record<string, CellLengths>;
export const emptyCutCells = (): CutCells => Object.create(null) as CutCells;

// At most `max` code units of `text`, never ending on the first half of a pair.
export function cutChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

const STATUS_TEXTS = ['value', 'error', 'reason'];

// One returned cell, cut: its new value and the length of the text it was cut
// from, or null when it fits. status: the cell is a run cell's {status, ...}.
export function cutCell(v: unknown, max: number, status = false): { value: unknown; full: number } | null {
  if (status && v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const view = v as Record<string, unknown>;
    const long = STATUS_TEXTS.filter(k => typeof view[k] === 'string' && (view[k] as string).length > max);
    if (long.length === 0) return null;
    const value = { ...view };
    for (const k of long) value[k] = cutChars(view[k] as string, max);
    return { value, full: Math.max(...long.map(k => (view[k] as string).length)) };
  }
  const text = typeof v === 'string' ? v : v !== null && typeof v === 'object' ? JSON.stringify(v) : null;
  return text !== null && text.length > max ? { value: cutChars(text, max), full: text.length } : null;
}

// A row's returned data with its cells cut, and the cells cut (column → full
// length, in its key order), null when none was. statusCells: the keys holding
// a run cell as {status, value, error}. A new object built with
// Object.fromEntries, so a column named "__proto__" stays a cell.
export function cutRow(
  data: Record<string, unknown>, max: number, statusCells: ReadonlySet<string>,
): { data: Record<string, unknown>; cut: CellLengths | null } {
  let cut: CellLengths | null = null;
  const out = Object.fromEntries(Object.entries(data).map(([column, v]) => {
    const c = cutCell(v, max, statusCells.has(column));
    if (!c) return [column, v];
    (cut ??= Object.create(null) as CellLengths)[column] = c.full;
    return [column, c.value];
  }));
  return { data: out, cut };
}
