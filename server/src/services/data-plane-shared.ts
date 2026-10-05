// Shared building blocks for programmatic data-plane writes — used by the
// /api/v1 routes AND the MCP tools (moved out of routes/api-v1-shared.ts so
// services never import from routes/).
import { db } from '../lib/db';
import { stripControlChars } from '../lib/csv-safety';
import { getSheetColumns } from '../lib/sql-helpers';
import { getLockedRunColumns } from '../routes/sheets-shared';
import { CELL_MAX_BASIC } from '../lib/constants';
import { isWebhookRawColumn } from '../lib/webhook-columns';

// Every programmatic data mutation bumps sheets.data_version INSIDE its
// transaction — the live-update signal an open tab's change poll watches.
// NEVER bump row_generation here (only sort / CSV-replace re-mean indices).
export function bumpDataVersion(sheetId: string, userId: string): void {
  db.prepare(
    `UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
     WHERE id = ? AND user_id = ?`,
  ).run(sheetId, userId);
}

// Sheet-wide active-run guard — same predicate as sort and bulk-delete.
export function sheetHasActiveRun(sheetId: string, userId: string): boolean {
  return !!db.prepare(`
    SELECT 1 FROM ai_runs WHERE sheet_id = ? AND user_id = ? AND status IN ('pending','running','paused')
    UNION SELECT 1 FROM http_runs WHERE sheet_id = ? AND user_id = ? AND status IN ('pending','running','paused')
    LIMIT 1
  `).get(sheetId, userId, sheetId, userId);
}

// Typed in-transaction failure results shared by the write flows. better-sqlite3
// transactions are sync, so flows set a flag and map it to a response after the
// txn returns (throwing would roll back AND lose the shape).
export type TxnFail =
  | { fail: 'cap'; remaining: number }
  | { fail: 'unknown_columns'; columns: string[] }
  | { fail: 'locked'; columns: string[] }
  | { fail: 'protected_columns'; columns: string[] }
  | { fail: 'active_run' }
  | { fail: 'busy'; message: string }
  | { fail: 'not_found' };

// Validate incoming columns against existing structure (UPDATE-ONLY: unknown
// column → error, never implicit creation) + run locks. Call INSIDE the write
// transaction (selfHeal=false — no nested write-back).
export function checkColumns(sheetId: string, userId: string, incoming: Set<string>): TxnFail | null {
  const existing = new Set(getSheetColumns(sheetId, userId, false));
  const unknown = [...incoming].filter(c => !existing.has(c));
  if (unknown.length > 0) return { fail: 'unknown_columns', columns: unknown };
  const protectedColumns = [...incoming].filter(c => isWebhookRawColumn(sheetId, userId, c));
  if (protectedColumns.length > 0) return { fail: 'protected_columns', columns: protectedColumns };
  const locked = getLockedRunColumns(sheetId, userId);
  const lockedHit = [...incoming].filter(c => locked.has(c));
  if (lockedHit.length > 0) return { fail: 'locked', columns: lockedHit };
  return null;
}

// Normalize a JSON cell value from an API client to the string the storage
// layer expects. null clears the cell to '' (NEVER json_remove — a removed key
// can ghost the column out of getSheetColumns' self-heal). Objects/arrays are
// a caller bug → undefined (reject the request).
export function normalizeCellValue(v: unknown): string | undefined {
  if (v === null) return '';
  if (typeof v === 'string') return stripControlChars(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

// Parse a {col: value} map common to append entries and row patches. Returns a
// NULL-PROTOTYPE map (a column legitimately named "__proto__" must land as an
// own key), or an error string.
export function parseCellMap(
  data: unknown, maxKeys: number,
): { cells: Record<string, string> } | { error: string } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: 'data must be an object of {columnName: value}' };
  }
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0) return { error: 'data must contain at least one column' };
  if (entries.length > maxKeys) return { error: `data cannot contain more than ${maxKeys} columns` };
  const cells: Record<string, string> = Object.create(null);
  for (const [col, raw] of entries) {
    const val = normalizeCellValue(raw);
    if (val === undefined) {
      return { error: `Value for column "${col.slice(0, 50)}" must be a string, number, boolean, or null` };
    }
    // Basic-tier cap for API/MCP-written cells: reject over the limit with a
    // dedicated message (a contract agents rely on), not
    // the type error above. Enrichment output (AI/HTTP runs) uses the larger
    // tier at its own write sites; a direct API cell write is a "basic" cell.
    if (val.length > CELL_MAX_BASIC) {
      return { error: `Value for column "${col.slice(0, 50)}" exceeds the ${CELL_MAX_BASIC}-character cell limit` };
    }
    cells[col] = val;
  }
  return { cells };
}

// Human-readable message for a TxnFail — shared by v1 responses and MCP tool
// errors so agents see identical wording on both surfaces.
export function txnFailMessage(f: TxnFail, maxRows: number): string {
  switch (f.fail) {
    case 'cap':
      return `Row limit reached (${maxRows} per sheet). You can add at most ${f.remaining} more.`;
    case 'unknown_columns':
      return `Unknown column(s): ${f.columns.join(', ')}. Create them first (add-column).`;
    case 'locked':
      return `An active run owns column(s): ${f.columns.join(', ')}. Wait for it to finish or cancel it.`;
    case 'protected_columns':
      return `Webhook provenance column(s) cannot be written directly: ${f.columns.join(', ')}.`;
    case 'active_run':
      return 'Cannot delete rows while a run is active on this sheet. Stop or finish the run first.';
    case 'busy':
      return f.message;
    case 'not_found':
      return 'Not found.';
  }
}
