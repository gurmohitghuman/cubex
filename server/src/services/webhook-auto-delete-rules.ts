// Auto-delete's rules (mode 'rules', migration 074): a where in read_rows' language (lib/row-filter), checked when
// it is saved (services/webhook-auto-delete.ts) and compiled again against the sheet as it is at every sweep
// (services/webhook-auto-delete-sweep.ts), and said in words for the sheet's History.
import { activeWhere, allOffError, groupItems, isGroup, isOrGroup, type WhereItem } from '../lib/row-filter/where';
import type { CompiledFilter } from '../lib/row-filter/sql';
import type { FilterOp } from '../lib/row-filter/ops';
import { fillingColumns } from '../lib/field-fill-columns';
import { prepareWhere } from './row-filter';

// The rules a save may store: a where the sheet can check now, with at least one condition on (all off would take
// every row). The error is the row filter's own, which names what to fix.
export function checkAutoDeleteRules(
  sheetId: string, userId: string, raw: unknown,
): { where: WhereItem[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'Mode "rules" needs where: the rules a row must pass.' };
  const prepared = prepareWhere(sheetId, userId, raw as WhereItem[]);
  if ('error' in prepared) return prepared;
  const off = allOffError(raw as WhereItem[], 'turn auto-delete off');
  return off ? { error: off } : { where: raw as WhereItem[] };
}

// The stored rules compiled for a sweep. wait: a column is filling from stored answers just now (a new clean,
// formula or lookup column, an added answer field), which ends on its own; error: they can't be checked until the
// person changes them or the sheet (a column they name is gone).
export function compileAutoDeleteRules(
  sheetId: string, userId: string, whereJson: string,
): { ok: CompiledFilter } | { wait: true } | { error: string } {
  if (fillingColumns(sheetId, userId).length > 0) return { wait: true };
  const prepared = prepareWhere(sheetId, userId, JSON.parse(whereJson) as WhereItem[]);
  return 'error' in prepared ? prepared : { ok: prepared.ok.filter };
}

// Each operator in the words the app's filter panel uses (client/src/lib/views.ts whereWords).
const OP_WORDS: Record<FilterOp, string> = {
  eq: 'is', neq: 'is not', contains: 'contains', not_contains: 'does not contain', starts_with: 'starts with',
  ends_with: 'ends with', empty: 'is empty', not_empty: 'is not empty', any_of: 'is any of',
  not_any_of: 'is none of', gt: 'is greater than', gte: 'is greater than or equal to', lt: 'is less than',
  lte: 'is less than or equal to', date_eq: 'date is', date_neq: 'date is not', date_gt: 'date is after',
  date_gte: 'date is on or after', date_lt: 'date is before', date_lte: 'date is on or before',
  has_error: 'has an error', has_result: 'has a result', not_run: 'is not run yet',
  condition_not_met: 'is kept out by "Only run if"', running: 'is still running',
  out_of_date: 'is out of date (its inputs changed)',
};

// The rules in words, for History: "Score" is less than "5" and ("Status" has a result or "Email" is not empty).
export function autoDeleteRulesWords(where: readonly WhereItem[]): string {
  const words = (item: WhereItem): string => {
    if (isGroup(item)) {
      const join = isOrGroup(item) ? ' or ' : ' and ';
      return `(${activeWhere(groupItems(item)).map(words).join(join)})`;
    }
    const subject = item.column === undefined ? 'any AI, HTTP API or enrichment column' : `"${item.column}"`;
    const value = item.values ? ` ${item.values.map(v => `"${v}"`).join(', ')}`
      : item.value === undefined ? '' : ` "${item.value}"`;
    return `${subject} ${OP_WORDS[item.operator] ?? item.operator}${value}`;
  };
  return activeWhere(where).map(words).join(' and ');
}
