import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import {
  TRANSFER_MAX_ROWS, TRANSFER_MAX_STORED_BYTES, TRANSFER_MAX_WRITER_MS,
} from '../lib/api-v1-constants';
import { countRows, getSheetColumns, purgeResultsForRows } from '../lib/sql-helpers';
import { bumpDataVersion, sheetHasActiveRun } from './data-plane-shared';
import { acquireTransferSlot, releaseTransferSlot } from './transfer-rate';
import { scanTransferRows, TransferSelection } from './transfer-selection';
import { planTransferColumns, applyTransferColumnOrder } from './transfer-columns';
import { isPristineSeedSheet } from './transfer-seed';
import {
  readTransferLedger, transferHashes, TransferRequest, TransferResult, writeTransferLedger,
} from './transfer-ledger';
import { cellOf, validateRowConditions } from './row-selection';
import { SEED_ROW_COUNT } from '../lib/seed-sheet';
import { nextRowIndex } from '../lib/sheet-busy';

export type { TransferRequest } from './transfer-ledger';

export type TransferOutcome =
  | { ok: TransferResult; replayed?: boolean }
  | { fail: 'invalid' | 'not_found' | 'conflict' | 'active_run' | 'cap' | 'budget' | 'rate' | 'active'; error: string };

class TransferBudgetError extends Error {}

function executeTransfer(userId: string, request: TransferRequest, hashes: string[]): TransferOutcome {
  const hash = hashes[0];
  const replay = readTransferLedger(userId, request.idempotencyKey, hashes);
  if (replay) return 'conflict' in replay
    ? { fail: 'conflict', error: 'Idempotency key was already used with different arguments.' }
    : { ok: replay.replay, replayed: true };
  const owns = db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ?');
  if (!owns.get(request.sourceSheetId, userId) || !owns.get(request.destinationSheetId, userId)) {
    return { fail: 'not_found', error: 'Source or destination sheet not found.' };
  }
  if (request.sourceSheetId === request.destinationSheetId) {
    return { fail: 'invalid', error: 'Source and destination sheets must be different.' };
  }
  if (sheetHasActiveRun(request.sourceSheetId, userId)
      || sheetHasActiveRun(request.destinationSheetId, userId)) {
    return { fail: 'active_run', error: 'Cannot transfer rows while either sheet has an active run.' };
  }
  const sourceColumns = getSheetColumns(request.sourceSheetId, userId, false);
  if ('where' in request.selection) {
    const invalid = validateRowConditions(sourceColumns, request.selection.where);
    if (invalid) return { fail: 'invalid', error: invalid };
  }
  const startedAt = Date.now();
  const checkTime = () => {
    if (Date.now() - startedAt > TRANSFER_MAX_WRITER_MS) throw new TransferBudgetError('Transfer exceeded writer time budget.');
  };
  const preflight = scanTransferRows(request.sourceSheetId, userId, request.selection, checkTime);
  if (preflight.missingIds.length) return { fail: 'not_found', error: 'One or more selected rows were not found.' };
  if (preflight.matched > TRANSFER_MAX_ROWS || preflight.bytes > TRANSFER_MAX_STORED_BYTES) {
    return { fail: 'budget', error: 'Transfer exceeds the row or stored-data budget.' };
  }
  const result: TransferResult = {
    matched: preflight.matched,
    copied: request.operation === 'copy' ? preflight.matched : 0,
    moved: request.operation === 'move' ? preflight.matched : 0,
    created_columns: [],
    dest_row_count: 0,
  };
  if (preflight.matched === 0) {
    result.dest_row_count = countRows(request.destinationSheetId, userId);
    writeTransferLedger(userId, request.idempotencyKey, hash, result);
    return { ok: result };
  }
  const pristine = isPristineSeedSheet(request.destinationSheetId, userId);
  const destinationCount = countRows(request.destinationSheetId, userId) - (pristine ? SEED_ROW_COUNT : 0);
  if (destinationCount + preflight.matched > MAX_ROWS_PER_SHEET) {
    return { fail: 'cap', error: `Destination row limit reached (${MAX_ROWS_PER_SHEET} per sheet).` };
  }
  const plan = planTransferColumns(
    request.sourceSheetId, request.destinationSheetId, userId,
    request.columnMapping, request.columnMode, pristine, request.columns,
  );
  if ('error' in plan) return { fail: 'invalid', error: plan.error };
  result.created_columns = plan.createdColumns;
  let storedBytes = 0;
  scanTransferRows(request.sourceSheetId, userId, request.selection, rows => {
    checkTime();
    for (const row of rows) {
      const projected: Record<string, string> = Object.create(null);
      for (const [source, destination] of plan.sourceToDestination) projected[destination] = cellOf(row.data, source);
      for (const marker of plan.ghostMarkers) projected[marker] = '';
      storedBytes += Buffer.byteLength(JSON.stringify(projected), 'utf8');
      if (storedBytes > TRANSFER_MAX_STORED_BYTES) throw new TransferBudgetError('Transfer exceeds stored-data budget.');
    }
  });
  let nextIndex = nextRowIndex(request.destinationSheetId, userId);
  const insert = db.prepare(
    'INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)',
  );
  const remove = db.prepare('DELETE FROM rows WHERE id = ? AND sheet_id = ? AND user_id = ?');
  scanTransferRows(request.sourceSheetId, userId, request.selection, rows => {
    checkTime();
    for (const row of rows) {
      const data: Record<string, string> = Object.create(null);
      for (const [source, destination] of plan.sourceToDestination) data[destination] = cellOf(row.data, source);
      // A ghost provenance marker (no destination row carries its key) must be
      // materialized as a blank cell: the read path prunes column_order entries
      // no row backs, which would silently un-reserve the marker again.
      for (const marker of plan.ghostMarkers) data[marker] = '';
      insert.run(uuidv4(), request.destinationSheetId, userId, nextIndex++, JSON.stringify(data));
    }
    if (request.operation === 'move') {
      purgeResultsForRows(request.sourceSheetId, userId, rows.map(r => r.index));
      for (const row of rows) remove.run(row.id, request.sourceSheetId, userId);
    }
  });
  if (pristine) db.prepare(
    'DELETE FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index >= 0 AND row_index < ?',
  ).run(request.destinationSheetId, userId, SEED_ROW_COUNT);
  applyTransferColumnOrder(request.destinationSheetId, userId, plan.finalOrder);
  bumpDataVersion(request.destinationSheetId, userId);
  if (request.operation === 'move') bumpDataVersion(request.sourceSheetId, userId);
  result.dest_row_count = countRows(request.destinationSheetId, userId);
  checkTime();
  writeTransferLedger(userId, request.idempotencyKey, hash, result);
  return { ok: result };
}

export function transferRows(userId: string, request: TransferRequest): TransferOutcome {
  if (!request.idempotencyKey || request.idempotencyKey.length > 200) {
    return { fail: 'invalid', error: 'idempotency_key must contain 1-200 characters.' };
  }
  if ('row_ids' in request.selection && new Set(request.selection.row_ids).size !== request.selection.row_ids.length) {
    return { fail: 'invalid', error: 'row_ids must not contain duplicates.' };
  }
  if (Object.entries(request.columnMapping).some(([source, destination]) => !source || typeof destination !== 'string')) {
    return { fail: 'invalid', error: 'column_mapping must map non-empty source names to destination name strings.' };
  }
  const slot = acquireTransferSlot(userId);
  if (slot !== 'ok') return {
    fail: slot,
    error: slot === 'rate' ? 'Too many transfer starts. Wait a minute and try again.' : 'Another transfer is already active.',
  };
  const hashes = transferHashes(request);
  try {
    return db.transaction(() => executeTransfer(userId, request, hashes)).immediate();
  } catch (error) {
    if (error instanceof TransferBudgetError) return { fail: 'budget', error: error.message };
    const winner = readTransferLedger(userId, request.idempotencyKey, hashes);
    if (winner) return 'conflict' in winner
      ? { fail: 'conflict', error: 'Idempotency key was already used with different arguments.' }
      : { ok: winner.replay, replayed: true };
    throw error;
  } finally {
    releaseTransferSlot(userId);
  }
}
