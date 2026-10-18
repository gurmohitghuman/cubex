// get_sheet and REST GET /sheets/:id: a sheet's meta (services/workspace-read.ts)
// with its column details cut to a size an agent can hold, and, on request,
// each column's filled / empty / error counts (services/column-counts.ts).
// columns: the ones the caller asks about, shown in full and counted first.
import {
  COLUMN_COUNTS_MAX_COLUMNS, COLUMN_DETAILS_MAX_CHARS, COLUMN_DETAILS_MAX_NAMED,
} from '../lib/constants-columns';
import { fitDetails, type ColumnCounts } from '../lib/column-details';
import { getSheetMeta, type SheetMeta } from './workspace-read';
import { columnCounts } from './column-counts';
import { sheetRunColumns } from './row-filter';

export interface SheetDetailsOptions { columns?: string[]; counts?: boolean; stop?: () => boolean }

export interface SheetDetails extends SheetMeta {
  column_details_note?: string;  // some details were cut short, and how to see them
  counts_note?: string;          // some columns weren't counted, and why
}

const quoted = (names: string[]) => names.map(c => `"${c}"`).join(', ');

export async function readSheetDetails(
  sheetId: string, userId: string, opts: SheetDetailsOptions = {},
): Promise<{ ok: SheetDetails } | { error: string } | null> {
  const named = [...new Set(opts.columns ?? [])];
  if (named.length > COLUMN_DETAILS_MAX_NAMED) return { error: `Name at most ${COLUMN_DETAILS_MAX_NAMED} columns.` };
  const meta = getSheetMeta(sheetId, userId, new Set(named));
  if (!meta) return null;
  const unknown = named.filter(c => !meta.columns.includes(c));
  if (unknown.length) return { error: `This sheet has no column named ${quoted(unknown)}.` };
  const out: SheetDetails = { ...meta };
  if (opts.counts) {
    const asked = named.length ? named : meta.columns;
    const filling = asked.filter(c => meta.filling_columns.includes(c));
    const countable = asked.filter(c => !filling.includes(c));
    const counted = countable.slice(0, COLUMN_COUNTS_MAX_COLUMNS);
    const outcome = await columnCounts(sheetId, userId, counted, sheetRunColumns(sheetId, userId, meta.columns),
      opts.stop);
    const counts: Map<string, ColumnCounts> = 'ok' in outcome ? outcome.ok : new Map();
    out.column_details = meta.column_details.map(d =>
      (asked.includes(d.name) ? { ...d, counts: counts.get(d.name) ?? null } : d));
    const notes = [
      ...('busy' in outcome ? [`${outcome.busy} Counts are left out.`] : []),
      ...(filling.length ? [`${quoted(filling)} still filling: count once get_sheet no longer lists `
        + `${filling.length === 1 ? 'it' : 'them'} in filling_columns.`] : []),
      ...(countable.length > counted.length ? [`Counted ${counted.length} columns; pass columns (up to `
        + `${COLUMN_COUNTS_MAX_COLUMNS}) to count others.`] : []),
    ];
    if (notes.length) out.counts_note = notes.join(' ');
  }
  const fitted = fitDetails(out.column_details, COLUMN_DETAILS_MAX_CHARS, new Set(named));
  out.column_details = fitted.details;
  if (fitted.shortened) {
    out.column_details_note = `${fitted.shortened} columns are listed by name and kind only, to keep this answer `
      + 'short: pass columns to see them in full.';
  }
  return { ok: out };
}
