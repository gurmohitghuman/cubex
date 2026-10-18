// get_sheet's column_details (and REST GET /sheets/:id): for every column, in
// the sheet's order, its kind, what fills it, what it reads, auto-run, its
// "Only run if" rule and its description. Each kind of filled column has a
// describer (services/column-details-*.ts) that claims the columns whose
// ColumnType (lib/column-types.ts) it knows; the rest are plain. A new kind of
// filled column adds its describer to DESCRIBERS and its name to ColumnKind.
import { sheetColumnKinds } from '../lib/column-types';
import { sheetColumnDescriptions } from '../lib/column-descriptions';
import {
  COLUMN_DETAIL_FULL_TEXT_CHARS, COLUMN_DETAIL_TEXT_CHARS, COLUMN_DETAILS_FULL_TEXT_BUDGET,
} from '../lib/constants-columns';
import { cutText, type ColumnDetail } from '../lib/column-details';
import { sheetEntries } from './autorun-entry';
import type { ColumnDescriber, DetailContext } from './column-details-context';
import { describeAiColumns } from './column-details-ai';
import { describeHttpColumns } from './column-details-http';
import { describeDerivedColumns, describeWebhookColumns } from './column-details-other';
import { describeWaterfallColumns } from './column-details-waterfall';

const DESCRIBERS: ColumnDescriber[] = [
  describeHttpColumns, describeAiColumns, describeWaterfallColumns, describeWebhookColumns, describeDerivedColumns,
];

// named: the columns the call asks about, shown with their prompts, formulas
// and URLs in full while those fit the shared budget (others are cut short).
export function sheetColumnDetails(
  sheetId: string, userId: string, columns: readonly string[], named: ReadonlySet<string> = new Set(),
): ColumnDetail[] {
  const kinds = sheetColumnKinds(sheetId, userId);
  let fullLeft = COLUMN_DETAILS_FULL_TEXT_BUDGET;
  const cut = (column: string, text: string): string => {
    if (named.has(column)) {
      const full = cutText(text, COLUMN_DETAIL_FULL_TEXT_CHARS);
      if (full.length <= fullLeft) { fullLeft -= full.length; return full; }
    }
    return cutText(text, COLUMN_DETAIL_TEXT_CHARS);
  };
  const ctx: DetailContext = {
    sheetId, userId, columns, listed: new Set(columns), types: kinds.types, runState: kinds.runState,
    autorun: new Map(sheetEntries(sheetId, userId).map(e => [e.status_column, e])),
    cut,
  };
  const found = new Map<string, ColumnDetail>();
  for (const describe of DESCRIBERS) for (const [column, detail] of describe(ctx)) found.set(column, detail);
  const descriptions = sheetColumnDescriptions(sheetId, userId);
  return columns.map(name => {
    const detail = found.get(name) ?? { name, kind: 'plain' };
    const description = descriptions.get(name);
    if (!description) return detail;
    // Right after the kind, where a reader looks first.
    const { name: _n, kind, ...rest } = detail;
    return { name, kind, description, ...rest };
  });
}
