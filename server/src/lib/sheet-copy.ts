// Copying a sheet's values to a new sheet (services/sheet-copy*.ts), the pure
// part: the cells a copied row keeps, the columns a copy takes, and the name
// a copy gets when none is given.
import { MAX_SHEET_NAME_LENGTH } from './constants';
import { holdsRunMarker } from './run-markers';

// The copied row: the chosen columns' values as they are, except that a cell
// holding a run's own words (⏳, ❌, ⏭️, ➕) is empty, as an empty cell is: no key.
export function copiedCells(data: Record<string, unknown>, columns: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const column of columns) {
    if (!Object.prototype.hasOwnProperty.call(data, column)) continue;
    const value = data[column];
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'string' && holdsRunMarker(value)) continue;
    out[column] = value;
  }
  return out;
}

// The columns to copy: every listed one, or those asked for (each listed, once), in the order asked.
export function columnsToCopy(listed: string[], asked: unknown): { ok: string[] } | { error: string } {
  if (asked === undefined || asked === null) return { ok: listed };
  if (!Array.isArray(asked) || asked.length === 0 || asked.some(c => typeof c !== 'string')) {
    return { error: 'columns must be a list of column names.' };
  }
  const known = new Set(listed);
  const missing = asked.filter(c => !known.has(c));
  if (missing.length > 0) {
    return { error: `No column named ${missing.slice(0, 3).map(c => `"${c}"`).join(', ')} in this sheet.` };
  }
  if (new Set(asked).size !== asked.length) return { error: 'columns names a column more than once.' };
  return { ok: asked as string[] };
}

// "Copy of Leads", then "Copy of Leads 2", "Copy of Leads 3"… (the first one
// no live sheet of the table has), cut to fit the name limit.
export function defaultCopyName(sourceName: string, taken: (name: string) => boolean): string {
  for (let n = 1; ; n++) {
    const name = fitName('Copy of ', sourceName, n === 1 ? '' : ` ${n}`);
    if (!taken(name)) return name;
  }
}

function fitName(prefix: string, base: string, suffix: string): string {
  let chars = Array.from(base);
  const room = MAX_SHEET_NAME_LENGTH - prefix.length - suffix.length;
  while (chars.join('').length > room) chars = chars.slice(0, -1);
  return `${prefix}${chars.join('').trimEnd()}${suffix}`;
}
