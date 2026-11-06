// What a row query answers (services/row-selection.ts and the reads it hands
// to: rows-by-id.ts, rows-since.ts). busy: a heavy operation holds the sheet
// (aggregates wait for it; REST answers 409).
export type QueryFail = { fail: 'invalid' | 'version_conflict' | 'busy'; error: string };
export type RowQueryResult = { ok: Record<string, unknown> } | QueryFail;
