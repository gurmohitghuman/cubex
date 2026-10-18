// read_rows' columns (with nested paths), group_by and aggregates, described
// once (lib/row-select/paths.ts, lib/row-aggregate/spec.ts check them).
import { z } from 'zod';
import {
  AGGREGATE_MAX_GROUPS, AGGREGATE_TOP_GROUPS, MAX_AGGREGATES, MAX_GROUP_BY_COLUMNS, MAX_PATH_DEPTH,
  MAX_PATH_KEY_CHARS, MCP_MAX_GROUP_CHARS,
} from '../lib/constants-query';
import { AGGREGATE_OPS } from '../lib/row-aggregate/spec';

const pick = z.object({
  column: z.string(),
  path: z.array(z.union([z.string().min(1).max(MAX_PATH_KEY_CHARS), z.number().int().min(0)]))
    .min(1).max(MAX_PATH_DEPTH).optional(),
  as: z.string().min(1).max(MAX_PATH_KEY_CHARS).optional(),
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
  op: z.enum(AGGREGATE_OPS),
  column: z.string().optional(),
}).strict()).min(1).max(MAX_AGGREGATES).describe(
  'Per group (or over all rows without group_by): count (rows; with a column, its non-empty cells), sum, avg, '
  + 'min, max of a column. Numbers are read like gt/lt ("1,000" counts; text that isn\'t a number is skipped; '
  + 'null when none). Each comes back in values under "sum(Revenue)", "count", ...',
);

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
