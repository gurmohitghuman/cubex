// The cell a new column gets from one row's stored result (pure), for "add a
// field from an answer". It writes what a run with that output would have
// written: an enrichment row by its own fill rule (a "not found" row stays
// empty, a rejected email fills only Cubex's own columns), an HTTP row as
// http-cell-values.ts does ('❌ Error' for a failed row, '⏭️ No data' when the
// answer has nothing there). null: leave the cell empty (nothing to write).
import { extractOutcome } from './jsonpath-extract';
import { cellText } from './enrich-cells';
import { fillReads, parseStored, readStored } from './answer-store';

export interface StoredResult { status: string; response_data: string | null }

// singleTool: a single tool's run (no waterfall, no email loop). Its "not
// found" only meant the outputs picked then were empty, so a new field reads
// its answer as a rerun with that output would.
export function enrichmentFieldCell(r: StoredResult, jsonPath: string, singleTool = false): string | null {
  if (r.status !== 'completed') return null;
  const stored = parseStored(r.response_data);
  if (stored === null) return null;
  const s = readStored(stored);
  const fill = singleTool && s.fill === 'none' ? 'all' : s.fill;
  if (!fillReads(fill, jsonPath) || s.body === null || typeof s.body !== 'object') return null;
  const got = extractOutcome(s.body, jsonPath);
  const text = got.matched && !got.error ? cellText(got.value) : '';
  return text === '' ? null : text;
}

export function httpFieldCell(r: StoredResult, jsonPath: string): string | null {
  if (r.status === 'failed') return '❌ Error';
  if (r.status !== 'completed') return null;
  const body = parseStored(r.response_data);
  if (body === null) return '⏭️ No data';
  const got = extractOutcome(body, jsonPath);
  if (got.error) return '❌ Error';
  const text = got.matched ? cellText(got.value) : '';
  return text === '' ? '⏭️ No data' : text;
}
