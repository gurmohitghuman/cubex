// The cells one enrichment row writes (pure): its status column and every
// output column. The worker persists exactly this map in the row and in
// http_results.extracted_fields, and the SSE stream replays that map
// (httpResultCellValues), so live cells match stored ones. Every column always
// gets a value, '' included, so no ⏳ placeholder is ever left behind.
import { extractOutcome } from './jsonpath-extract';
import { stripControlChars, clampCellChars } from './csv-safety';
import { CELL_MAX_ENRICHMENT } from './constants';
import type { ResponseMapping } from './http-request-template';

export const ENRICH_CELL = {
  found: '✅ Found',
  // A list job that filled the row's own outputs but had no results to add.
  noRows: '✅ No rows to add',
  notFound: '⏭️ Not found',
  budget: '⏭️ Budget ran out',
} as const;

// found: outputs filled from the answer. rejected: the email loop found
// addresses but none passed; only its own columns (status, checked by) fill.
// empty: nothing to show (not found, over budget, missing inputs, failed).
export type OutputFill = 'all' | 'cubex' | 'none';

export interface RowCells {
  status: 'completed' | 'failed';   // http_results.status
  statusCell: string;               // '' for a row skipped for missing inputs
  answer: unknown;                  // what outputs read (treg's answer + _cubex)
  fill: OutputFill;
  reason: string | null;            // http_results.error_message
}

const MAX_REASON_CELL = 120;

export function failedCell(message: string): string {
  const one = message.replace(/\s+/g, ' ').trim();
  return `❌ ${one.length > MAX_REASON_CELL ? `${one.slice(0, MAX_REASON_CELL - 1)}…` : one}`;
}

// A value as a cell: objects as JSON text, control characters out, clamped.
// HTTP columns write values the same way (http-cell-values.ts).
export function cellText(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  return clampCellChars(stripControlChars(typeof v === 'object' ? JSON.stringify(v) : String(v)), CELL_MAX_ENRICHMENT);
}

export function enrichCellValues(r: RowCells, mapping: ResponseMapping[], masterColumn: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of mapping) {
    const read = r.fill === 'all' || (r.fill === 'cubex' && m.jsonPath.startsWith('$._cubex.'));
    if (!read || r.answer === null || typeof r.answer !== 'object') { out[m.columnName] = ''; continue; }
    const got = extractOutcome(r.answer, m.jsonPath);
    out[m.columnName] = got.matched && !got.error ? cellText(got.value) : '';
  }
  if (masterColumn) out[masterColumn] = clampCellChars(stripControlChars(r.statusCell), CELL_MAX_ENRICHMENT);
  return out;
}
