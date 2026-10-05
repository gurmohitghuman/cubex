// Single source of truth for the CELL STRINGS an HTTP run writes per result row.
// Both the worker (http-row.ts, which persists them) and the SSE stream
// (http-jobs.ts, which paints them live) compute the same map here, so the live
// grid matches the persisted state exactly. Before this, the SSE 'result' event
// carried no field values at all, so HTTP cells sat on '⏳ Processing...' until a
// full reload (the client's extractedFields branch was effectively dead — M12).
//
// Mirrors http-row.ts's writeRowColumns inputs:
//   - completed + any non-empty value → each mapping col = String(value), or
//     '⏭️ No data' for that col if its own value is empty/null (partial match);
//     master col = '✅ Success'
//   - completed + ALL empty            → each mapping col = '⏭️ No data',
//     master col = '⏭️ Skipped'
//   - failed                           → each mapping col = '❌ Error',
//     master col = '❌ Failed'
// Every mapping column ALWAYS gets a value here — never leave one unset, or its
// run-start '⏳ Processing...' placeholder is never cleared (cell stuck forever).
import { stripControlChars, clampCellChars } from './csv-safety';
import { CELL_MAX_ENRICHMENT } from './constants';

export function httpResultCellValues(opts: {
  status: string;                                   // http_results.status
  extractedFields: Record<string, unknown>;         // parsed http_results.extracted_fields
  mappingColumns: string[];                         // config.responseMapping[].columnName
  masterColumn: string | null;                      // run.master_column_name
}): Record<string, string> {
  const { status, extractedFields, mappingColumns, masterColumn } = opts;
  const out: Record<string, string> = {};

  if (status === 'failed') {
    for (const col of mappingColumns) out[col] = '❌ Error';
    if (masterColumn) out[masterColumn] = '❌ Failed';
    return out;
  }

  const values = Object.values(extractedFields);
  const allEmpty = values.length === 0
    || values.every(v => v === null || v === undefined || v === '');

  if (allEmpty) {
    for (const col of mappingColumns) out[col] = '⏭️ No data';
    if (masterColumn) out[masterColumn] = '⏭️ Skipped';
    return out;
  }

  // Iterate the FULL mapping column list (not just the keys that extracted a
  // value): run-start wrote '⏳ Processing...' to EVERY mapping column, and this
  // map is the only thing that overwrites it. A partial match (some fields found,
  // others null/missing) must still clear the placeholder on the empty ones —
  // otherwise those cells stay stuck on '⏳ Processing...' forever even though the
  // run completed. Empty fields in a partial-success row → '⏭️ No data'.
  for (const col of mappingColumns) {
    const v = extractedFields[col];
    // Extracted value: strip control chars (P2-9 — this worker path let raw
    // JSON controls through) and clamp to the enrichment cell cap (P2-8).
    // Computed identically here for BOTH the persisted cell and the SSE paint,
    // so live == stored. Status markers above are short fixed strings, untouched.
    // An object or array (a JSONPath like $.company) is written as its JSON text;
    // String() gave "[object Object]".
    out[col] = (v === undefined || v === null || v === '')
      ? '⏭️ No data'
      : clampCellChars(stripControlChars(typeof v === 'object' ? JSON.stringify(v) : String(v)), CELL_MAX_ENRICHMENT);
  }
  if (masterColumn) out[masterColumn] = '✅ Success';
  return out;
}
