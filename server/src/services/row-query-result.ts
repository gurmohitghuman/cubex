// What a row query answers (services/row-selection.ts and the reads it hands
// to: rows-by-id.ts, rows-since.ts). busy: a heavy operation holds the sheet
// (aggregates wait for it; REST answers 409).
import type { ToolAnswer } from '../mcp/tool-outputs';
export type QueryFail = { fail: 'invalid' | 'version_conflict' | 'busy'; error: string };
// The answer has the type of read_rows' outputSchema (a type only: the schema module isn't loaded here), so a
// reader that answers a field the schema doesn't allow fails the typecheck.
export type RowsAnswer = ToolAnswer<'read_rows'>;
export type RowQueryResult = { ok: RowsAnswer } | QueryFail;
