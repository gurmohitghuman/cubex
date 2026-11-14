// read_rows' columns (with nested paths), group_by, aggregates and
// max_chars_per_cell, described once (lib/row-select/paths.ts,
// lib/row-aggregate/spec.ts and services/row-query-input.ts check them).
import { z } from 'zod';
import {
  AGGREGATE_MAX_GROUPS, AGGREGATE_TOP_GROUPS, CELL_CUT_MAX_CHARS, CELL_CUT_MIN_CHARS, MAX_AGGREGATES,
  MAX_GROUP_BY_COLUMNS, MAX_PATH_DEPTH, MAX_PATH_KEY_CHARS, MCP_MAX_GROUP_CHARS,
} from '../lib/constants-query';
import { AGGREGATE_OPS } from '../lib/row-aggregate/spec';
import { CELL_CUT_REFUSAL } from '../services/row-query-input';
import { lenientInt } from './tool-helpers';

const pick = z.object({
  column: z.string().describe('The column holding JSON'),
  path: z.array(z.union([z.string().min(1).max(MAX_PATH_KEY_CHARS), z.number().int().min(0)]))
    .min(1).max(MAX_PATH_DEPTH).optional().describe('Keys and list positions (from 0) into its JSON'),
  as: z.string().min(1).max(MAX_PATH_KEY_CHARS).optional().describe('The name the value comes back under'),
}).strict();

export const columnsSchema = z.array(z.union([z.string(), pick])).min(1).describe(
  'Only these columns. Omit for all (expensive on wide sheets). An item can also take one value out of a JSON '
  + 'cell (an HTTP API answer, say): {"column":"Response","path":["data","emails",0],"as":"Email"}. path is '
  + `plain keys (an object's key, or a list position from 0), at most ${MAX_PATH_DEPTH}, not JSONPath; the value `
  + 'comes back as it is in the JSON (text, number, object, list), or null when the cell isn\'t JSON or has no '
  + 'such key. Without as, it is named "Response.data.emails.0".',
);

export const groupBySchema = z.array(z.string()).min(1).max(MAX_GROUP_BY_COLUMNS).describe(
  `Count rows per value of up to ${MAX_GROUP_BY_COLUMNS} columns instead of reading rows: groups ignore case and `
  + 'outer spaces (like eq), an empty cell is the group "". Answers rows_matched, group_count, the largest '
  + `groups as {group, count, values} (by count, up to ${AGGREGATE_TOP_GROUPS.toLocaleString('en-US')}) and `
  + 'truncated when there were more. Takes where and view; not cursor, limit, columns, return_mode or '
  + 'include_status. On a column with very many different values (emails, ids) it stops past '
  + `${AGGREGATE_MAX_GROUPS.toLocaleString('en-US')} groups. While the sheet is busy (an import, a sort, a column `
  + 'filling) it answers busy: try again when that finishes.',
);

export const aggregatesSchema = z.array(z.object({
  op: z.enum(AGGREGATE_OPS).describe('What to work out'),
  column: z.string().optional().describe('The column; count without one counts rows'),
}).strict()).min(1).max(MAX_AGGREGATES).describe(
  'Per group (or over all rows without group_by): count (rows; with a column, its non-empty cells), sum, avg, '
  + 'min, max of a column. Numbers are read like gt/lt ("1,000" counts; text that isn\'t a number is skipped; '
  + 'null when none). Each comes back in values under "sum(Revenue)", "count", ...',
);

// Shared with the REST body's description (openapi/routes-rows.ts).
export const MAX_CHARS_PER_CELL_HELP = 'Cut each cell\'s text to its first N characters, N from '
  + `${CELL_CUT_MIN_CHARS} to ${CELL_CUT_MAX_CHARS.toLocaleString('en-US')}. cut_cells then lists the cells `
  + 'cut by row id, then column, with each one\'s full length: {"<row id>": {"Notes": 5120}}, a row only when '
  + 'a cell of it was cut ({} when none). Characters count as JavaScript counts them (an emoji is 2): a cut never '
  + 'leaves half of a surrogate pair, but an emoji built from several characters (a skin tone, a flag, a family) '
  + 'can lose its last parts. With include_status a run cell\'s value or error is cut, never its status. A value '
  + 'a columns path takes out of a JSON cell: an object or list is cut as its JSON text (it comes back as text), '
  + 'numbers and true/false never. Rows only: not with group_by, aggregates or return_mode ids or count.';
// Over MCP digits sent as text are the number (a model often quotes it), and
// every value refused gets the words REST answers (services/row-query-input.ts).
export const maxCharsPerCellSchema = lenientInt(CELL_CUT_MIN_CHARS, CELL_CUT_MAX_CHARS, CELL_CUT_REFUSAL)
  .describe(MAX_CHARS_PER_CELL_HELP);

// An MCP answer's groups, cut to about MCP_MAX_GROUP_CHARS (an agent's context):
// truncated then says more exist.
export function fitGroups(answer: Record<string, unknown>): Record<string, unknown> {
  const groups = answer.groups as unknown[];
  let size = 0, keep = 0;
  for (; keep < groups.length; keep++) {
    size += JSON.stringify(groups[keep]).length + 1;
    if (size > MCP_MAX_GROUP_CHARS && keep > 0) break;
  }
  if (keep === groups.length) return answer;
  return { ...answer, groups: groups.slice(0, keep), truncated: true };
}
