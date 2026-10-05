import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import type { TransferSelection } from './transfer-selection';

export interface TransferRequest {
  sourceSheetId: string;
  destinationSheetId: string;
  operation: 'copy' | 'move';
  selection: TransferSelection;
  columns?: string[]; // subset of source columns to transfer; omitted = all
  columnMode: 'require_existing' | 'create_missing';
  // True when the wire request did not specify column_mode. Pre-4d that meant
  // require_existing; the legacy-hash fallback may only assume the old default
  // for requests that actually omitted the field (an EXPLICIT mode change on a
  // reused key must conflict, not replay).
  columnModeOmitted: boolean;
  columnMapping: Record<string, string>;
  idempotencyKey: string;
}

function canonicalRequest(r: TransferRequest): Record<string, unknown> {
  return {
    source_sheet_id: r.sourceSheetId,
    destination_sheet_id: r.destinationSheetId,
    operation: r.operation,
    selection: 'all' in r.selection ? { all: true }
      : 'row_ids' in r.selection ? { row_ids: [...r.selection.row_ids].sort() }
      : { where: r.selection.where },
    columns: r.columns ? [...r.columns].sort() : null,
    column_mode: r.columnMode,
    column_mapping: r.columnMapping,
  };
}

// [0] = the current canonical hash (what writes store), followed by accepted
// legacy encodings of the SAME wire request. Entries written before the
// `columns` field and the create_missing default existed must replay instead
// of conflicting — otherwise an agent retrying a completed pre-upgrade copy
// sees 409 and reaches for a fresh key, duplicating rows. Requests using
// `columns` can't have legacy entries (the field didn't exist); the old
// require_existing default applies ONLY when the wire request omitted
// column_mode (or require_existing→create_missing would false-replay).
export function transferHashes(r: TransferRequest): string[] {
  const hashes = [transferRequestHash(canonicalRequest(r))];
  if (!r.columns) {
    const legacy = (mode: TransferRequest['columnMode']) => {
      const c = canonicalRequest({ ...r, columnMode: mode });
      delete c.columns;
      return transferRequestHash(c);
    };
    hashes.push(legacy(r.columnMode));
    if (r.columnModeOmitted) hashes.push(legacy('require_existing'));
  }
  return [...new Set(hashes)];
}

// Replays return the STORED result verbatim: created_columns and
// dest_row_count reflect the destination as of the original operation.
// Optional because entries written before the 4d contract lack them —
// legacy replays simply omit the fields.
export interface TransferResult {
  matched: number; copied: number; moved: number;
  created_columns?: string[]; dest_row_count?: number;
}

export function transferRequestHash(request: Record<string, unknown>): string {
  const normalized = {
    ...request,
    row_ids: Array.isArray(request.row_ids) ? [...request.row_ids].sort() : request.row_ids,
    column_mapping: request.column_mapping && typeof request.column_mapping === 'object'
      ? Object.fromEntries(Object.entries(request.column_mapping as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : {},
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

// `hashes` = transferHashes() output: the current canonical hash plus any
// accepted legacy encodings of the SAME wire request — an entry stored under
// an older canonical form must replay, not conflict.
export function readTransferLedger(
  userId: string, key: string, hashes: string[],
): { replay: TransferResult } | { conflict: true } | null {
  const row = db.prepare(
    'SELECT request_hash, result_json FROM data_operation_ledger WHERE user_id = ? AND idempotency_key = ?',
  ).get(userId, key) as { request_hash: string; result_json: string } | undefined;
  if (!row) return null;
  if (!hashes.includes(row.request_hash)) return { conflict: true };
  return { replay: JSON.parse(row.result_json) as TransferResult };
}

export function writeTransferLedger(
  userId: string, key: string, hash: string, result: TransferResult,
): void {
  db.prepare(`
    INSERT INTO data_operation_ledger
      (id, user_id, idempotency_key, operation_kind, request_hash, result_json)
    VALUES (?, ?, ?, 'rows_transfer', ?, ?)
  `).run(uuidv4(), userId, key, hash, JSON.stringify(result));
  db.prepare(`
    DELETE FROM data_operation_ledger WHERE id IN (
      SELECT id FROM data_operation_ledger WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 25 OFFSET 1000
    )
  `).run(userId);
}
