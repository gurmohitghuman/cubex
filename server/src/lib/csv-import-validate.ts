import { MAX_COLUMNS_PER_SHEET, MAX_ROWS_PER_SHEET } from './constants';
import { countColumnsAndRows, getSheetColumns } from './sql-helpers';
import {
  sanitizeAndValidateColumnName, findColumnNameCollision, columnCollisionMessage,
} from './column-names';
import { CsvSummary } from './csv-import-parse';

const CSV_FIX = 'Rename it in the CSV and re-upload.';
const CSV_FIX_OR_REPLACE = 'Rename it in the CSV, or check "Replace existing data" to overwrite the sheet.';

// Validation half of CSV import (parsing lives in csv-import-parse.ts). Validates
// the CSV's columns and row count (a summary, never the rows themselves) against
// name rules, case/token collisions, and caps. ZERO mutation: returns a string
// on rejection (the 400 body), or what the commit needs on success.
export interface ValidCsvImport {
  csvColumns: string[];
  newColumns: string[];
  existing: { columns: number; rows: number };
}

export function validateCsvImport(
  summary: CsvSummary,
  sheetId: string,
  userId: string,
  replace: boolean,
): { error: string } | { ok: ValidCsvImport } {
  // Header list first (CSV order, and the only source when there are no data
  // rows — a header-only CSV still declares its columns), then any straggler
  // keys rows carry that the header line didn't (lib/csv-import-parse.ts).
  const csvColumns = summary.columns;
  const rowCount = summary.rowCount;

  // Relaxed, Google-Sheets-like name rule via the shared helper (same contract as
  // manual add/rename, AI, HTTP, webhook): symbol headers ("# Revenue", "Q1 (2024)")
  // and "__source_lsn" import fine; only symbol-only names and the reserved
  // __rowIndex are rejected. (sanitizeColumnName already stripped "/\ in parseCsvFile.)
  for (const c of csvColumns) {
    const v = sanitizeAndValidateColumnName(c);
    if ('error' in v) return { error: `CSV column "${c}" is not a valid name. ${v.error} ${CSV_FIX}` };
  }

  // Enforce caps BEFORE any mutation. In replace mode the post-import state is "just
  // the CSV", so compare against 0 existing — but the caller hasn't deleted anything
  // yet, so a failed cap check leaves the original sheet untouched.
  const existing = replace ? { columns: 0, rows: 0 } : countColumnsAndRows(sheetId, userId);

  const existingCols = new Set(replace ? [] : getSheetColumns(sheetId, userId, false));

  // Reject collisions (exact / case-insensitive / normalized-/token) BEFORE any
  // mutation — two columns sharing a /token make processPromptTemplate
  // non-deterministic. Checked (a) WITHIN the CSV (one header vs the earlier ones)
  // and (b) append mode: each header vs existing columns. Reject, don't auto-merge.
  const seen: string[] = [];
  for (const c of csvColumns) {
    const within = findColumnNameCollision(c, seen);
    if (within) return { error: `CSV: ${columnCollisionMessage(c, within, CSV_FIX)}` };
    seen.push(c);
  }
  if (!replace) {
    for (const c of csvColumns) {
      const clash = findColumnNameCollision(c, existingCols);
      // EXACT-name overlap merges into the existing column — appending a CSV
      // exported from the same sheet is the canonical append workflow, and the
      // commit path + newColumns filter below are built for it. Only case/token
      // VARIANTS are rejected ("Domain" vs "domain", "# Revenue" vs "Revenue"):
      // those would make /column resolution non-deterministic. (The collision
      // helper refactor had made exact matches reject here too, which broke
      // every same-header append with a confusing "already exists" 400.)
      if (clash && clash.kind !== 'exact') {
        return { error: `CSV column ${columnCollisionMessage(c, clash, CSV_FIX_OR_REPLACE)}` };
      }
    }
  }

  // Columns the CSV introduces that the sheet doesn't already have (used for the
  // cap check and reported back so the client can surface "M new columns").
  const newColumns = csvColumns.filter(c => !existingCols.has(c));
  if (existing.columns + newColumns.length > MAX_COLUMNS_PER_SHEET) {
    return { error: `CSV would push the sheet past ${MAX_COLUMNS_PER_SHEET} columns (${existing.columns} existing + ${newColumns.length} new). Trim the CSV or remove unused columns first.` };
  }
  if (existing.rows + rowCount > MAX_ROWS_PER_SHEET) {
    // "Replace existing data" (the import checkbox) only helps when the CSV
    // ITSELF fits under the cap — it just clears the existing rows first. If
    // the file alone is over the cap, suggesting it is useless (and confusing
    // when there are 0 existing rows). Tailor the advice to which case it is.
    const csvAloneFits = rowCount <= MAX_ROWS_PER_SHEET;
    const advice = csvAloneFits && existing.rows > 0
      ? `Split the CSV, or check "Replace existing data" to overwrite the ${existing.rows} existing rows instead of appending.`
      : `This file alone has more than the ${MAX_ROWS_PER_SHEET.toLocaleString()}-row limit. Split it into smaller files and import them separately.`;
    return { error: `CSV would put the sheet over its ${MAX_ROWS_PER_SHEET.toLocaleString()}-row limit (${existing.rows.toLocaleString()} existing + ${rowCount.toLocaleString()} new). ${advice}` };
  }

  return { ok: { csvColumns, newColumns, existing } };
}
