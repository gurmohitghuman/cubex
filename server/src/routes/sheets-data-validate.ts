import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import { sanitizeColumnName } from '../lib/sql-helpers';

// rawColumnName: the key as sent, when sanitizing changed it. A column
// registered under that exact name (before a newer sanitizing rule existed)
// still takes the edit: see applyDataWrite.
export type ParsedUpdate = { rowIndex: number; columnName: string; value: string; rawColumnName?: string };

export interface ParsedDataBody {
  mode: 'upsert' | 'update';
  updates: ParsedUpdate[];
  // The row_generation the client claims it loaded at (migration 021 fence), or
  // undefined for a legacy client that omits it (check is then skipped).
  clientGen: number | undefined;
}

// Validate + normalize the PUT /:id/data body. Returns either a 400 error string
// (the caller responds) or the parsed payload. Pulled out of the route so the
// handler stays focused on the write transaction.
//
// Without this a malformed body (non-array updates, missing fields, wrong types)
// hits SQLite with garbage parameters and either silently no-ops or 500s with a
// confusing error. A rowIndex coerced to a string by SQLite silently matches no
// row, so the user thinks the save worked.
export function parseDataBody(body: unknown): { error: string } | ParsedDataBody {
  const rawBody = body as { updates?: unknown };

  if (!Array.isArray(rawBody.updates)) {
    return { error: 'Request body must include `updates` as an array.' };
  }
  if (rawBody.updates.length > MAX_ROWS_PER_SHEET) {
    return { error: `Too many updates in one request (max ${MAX_ROWS_PER_SHEET}).` };
  }

  // Write mode. 'update' is UPDATE-ONLY defense-in-depth for GRID cell edits:
  // it NEVER inserts a row or appends a column, so a stale/queue-bypassing edit
  // (a client without the generation fence, a resurrected job, etc.) can't
  // recreate a deleted row/column. Cells whose row OR column no longer exists
  // are silently skipped (reported in `skipped`). Default 'upsert' preserves the
  // structure-creating behavior the AI/HTTP preview-commit paths rely on.
  // Anything other than the literal 'update' falls back to 'upsert' (back-compat).
  const mode = (rawBody as { mode?: unknown }).mode === 'update' ? 'update' : 'upsert';

  const updates: ParsedUpdate[] = [];
  for (let i = 0; i < rawBody.updates.length; i++) {
    const u = rawBody.updates[i] as { rowIndex?: unknown; columnName?: unknown; value?: unknown };
    if (!u || typeof u !== 'object') return { error: `updates[${i}] must be an object.` };
    if (typeof u.rowIndex !== 'number' || !Number.isInteger(u.rowIndex) || u.rowIndex < 0) {
      return { error: `updates[${i}].rowIndex must be a non-negative integer.` };
    }
    if (typeof u.columnName !== 'string' || u.columnName.trim() === '') {
      return { error: `updates[${i}].columnName must be a non-empty string.` };
    }
    if (u.value !== null && typeof u.value !== 'string') {
      return { error: `updates[${i}].value must be a string (or null).` };
    }
    // Sanitize column names at the cell-edit boundary too. Without this, an upsert
    // that implicitly creates a new column with a name like foo"bar would crash
    // every json_set on this sheet afterwards.
    const columnName = sanitizeColumnName(u.columnName);
    updates.push({
      rowIndex: u.rowIndex,
      columnName,
      value: u.value == null ? '' : u.value,
      ...(columnName === u.columnName ? {} : { rawColumnName: u.columnName }),
    });
  }

  const rawGen = (rawBody as { rowGeneration?: unknown }).rowGeneration;
  const clientGen = typeof rawGen === 'number' ? rawGen : undefined;

  return { mode, updates, clientGen };
}
