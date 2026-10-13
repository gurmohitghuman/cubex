// How an HTTP request template's token names a column (replaceTemplateVariables'
// rule: any case, or the normalized name), and the columns a stored request
// read that were deleted since (requestConfig.goneColumns). A leaf: the
// template, validation, rename/delete and auto-run code all import it.
//
// Why the deleted names are kept: a token matching no column falls through to
// a saved key of the same name. A {{X}} that read column X must not quietly
// send key X once X is deleted, so the column delete records X in the configs
// that read it (lib/column-ref-rename.ts markTemplateColumnGone), and from then
// on that name never resolves to a key: the run refuses the row, and a rerun or
// auto-run refuses to start. A column by that name again is read as before.
import { normalizeColumnName } from './prompt';

export const templateTokenIs = (token: string, column: string): boolean =>
  column.toLowerCase() === token.toLowerCase() || normalizeColumnName(column) === normalizeColumnName(token);

// The deleted columns a stored request config read (anything malformed reads as none).
export function goneColumnsOf(rc: unknown): string[] {
  const list = rc && typeof rc === 'object' ? (rc as { goneColumns?: unknown }).goneColumns : undefined;
  return Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string') : [];
}

// The deleted column a token names, if any.
export const goneColumnFor = (token: string, gone: readonly string[]): string | undefined =>
  gone.find(c => templateTokenIs(token, c));

// What a run, rerun or auto-run says when the request reads one.
export const goneColumnMessage = (column: string): string =>
  `This column reads ${column}, which isn't in this sheet anymore. Edit the column first.`;
