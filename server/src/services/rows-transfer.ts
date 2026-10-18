// Over 200 lines: one transfer, from its checks to the ledger, in the transaction that makes it.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import {
  TRANSFER_MAX_ROWS, TRANSFER_MAX_STORED_BYTES, TRANSFER_MAX_WRITER_MS,
} from '../lib/api-v1-constants';
import { countRows, getSheetColumns } from '../lib/sql-helpers';
import { bumpDataVersion, sheetHasActiveRun } from './data-plane-shared';
import { acquireTransferSlot, releaseTransferSlot } from './transfer-rate';
import { scanTransferRows, type ScanSelection } from './transfer-selection';
import { planTransferColumns, applyTransferColumnOrder } from './transfer-columns';
import { isPristineSeedSheet } from './transfer-seed';
import {
  readTransferLedger, transferHashes, TransferRequest, TransferResult, writeTransferLedger,
} from './transfer-ledger';
import { cellOf } from './row-selection';
import { prepareWhere } from './row-filter';
import { SEED_ROW_COUNT } from '../lib/seed-sheet';
import { nextRowIndex } from '../lib/sheet-busy';
import { settleRows } from './auto-dedupe-settle';
import { autoDedupeAnswer } from './auto-dedupe-answer';
import type { Surface } from './trash-answer';
import { autorunRowsRemoved } from '../lib/autorun-mark';
import { sheetRunBlock } from './autorun-block';
import { deleteRowsToTrash } from './trash-rows';
import { countOf, logSheetChange } from '../lib/change-log';

export type { TransferRequest } from './transfer-ledger';

export type TransferOutcome =
  | { ok: TransferResult; replayed?: boolean }
  | { fail: 'invalid' | 'not_found' | 'conflict' | 'active_run' | 'cap' | 'budget' | 'rate' | 'active'; error: string };

class TransferBudgetError extends Error {}

function executeTransfer(
  userId: string, request: TransferRequest, hashes: string[], surface: Surface,
): TransferOutcome {
  const hash = hashes[0];
  const replay = readTransferLedger(userId, request.idempotencyKey, hashes);
  if (replay) return 'conflict' in replay
    ? { fail: 'conflict', error: 'Idempotency key was already used with different arguments.' }
    : { ok: replay.replay, replayed: true };
  const owns = db.prepare('SELECT id FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL');
  if (!owns.get(request.sourceSheetId, userId) || !owns.get(request.destinationSheetId, userId)) {
    return { fail: 'not_found', error: 'Source or destination sheet not found.' };
  }
  if (request.sourceSheetId === request.destinationSheetId) {
    return { fail: 'invalid', error: 'Source and destination sheets must be different.' };
  }
  for (const sheet of [request.sourceSheetId, request.destinationSheetId]) {
    if (!sheetHasActiveRun(sheet, userId)) continue;
    // An auto-run run gets its own words and the sheet yields (services/autorun-block.ts).
    const busy = 'Cannot transfer rows while either sheet has an active run.';
    return { fail: 'active_run', error: sheetRunBlock(sheet, userId, busy)?.message || busy };
  }
  let scan: ScanSelection;
  if ('where' in request.selection) {
    const sourceColumns = getSheetColumns(request.sourceSheetId, userId, false);
    const prepared = prepareWhere(request.sourceSheetId, userId, request.selection.where, sourceColumns);
    if ('error' in prepared) return { fail: 'invalid', error: prepared.error };
    scan = { filter: prepared.ok.filter };
  } else {
    scan = request.selection;
  }
  const startedAt = Date.now();
  const checkTime = () => {
    if (Date.now() - startedAt > TRANSFER_MAX_WRITER_MS) {
      throw new TransferBudgetError('Transfer exceeded writer time budget.');
    }
  };
  const preflight = scanTransferRows(request.sourceSheetId, userId, scan, checkTime);
  // The passes below read only the rows this one found (one transaction: they can't change).
  const found: ScanSelection = { rowids: preflight.rowids };
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
  scanTransferRows(request.sourceSheetId, userId, found, rows => {
    checkTime();
    for (const row of rows) {
      const projected: Record<string, string> = Object.create(null);
      for (const [source, destination] of plan.sourceToDestination) projected[destination] = cellOf(row.data, source);
      for (const marker of plan.ghostMarkers) projected[marker] = '';
      storedBytes += Buffer.byteLength(JSON.stringify(projected), 'utf8');
      if (storedBytes > TRANSFER_MAX_STORED_BYTES) {
        throw new TransferBudgetError('Transfer exceeds stored-data budget.');
      }
    }
  });
  let nextIndex = nextRowIndex(request.destinationSheetId, userId);
  const insert = db.prepare(
    'INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)',
  );
  // A move takes the source rows to the trash, whole (columns left out of the
  // mapping included), one batch for the whole move.
  let trashId: number | null = null;
  const rids: number[] = [];
  const added = new Set<string>();
  scanTransferRows(request.sourceSheetId, userId, found, rows => {
    checkTime();
    for (const row of rows) {
      const data: Record<string, string> = Object.create(null);
      for (const [source, destination] of plan.sourceToDestination) data[destination] = cellOf(row.data, source);
      // A ghost provenance marker (no destination row carries its key) must be
      // materialized as a blank cell: the read path prunes column_order entries
      // no row backs, which would silently un-reserve the marker again.
      for (const marker of plan.ghostMarkers) data[marker] = '';
      const id = uuidv4();
      added.add(id);
      rids.push(Number(insert.run(id, request.destinationSheetId, userId, nextIndex++, JSON.stringify(data))
        .lastInsertRowid));
    }
    if (request.operation === 'move') {
      const moved = deleteRowsToTrash(request.sourceSheetId, userId, 'transfer', { ids: rows.map(r => r.id) },
        trashId ?? undefined);
      trashId = moved.trashId ?? trashId;
    }
  });
  if (pristine) db.prepare(
    'DELETE FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index >= 0 AND row_index < ?',
  ).run(request.destinationSheetId, userId, SEED_ROW_COUNT);
  applyTransferColumnOrder(request.destinationSheetId, userId, plan.finalOrder);
  // Auto-dedupe in the destination: a row it already has isn't added again (or replaces it).
  const auto = autoDedupeAnswer(userId, settleRows(request.destinationSheetId, userId, rids, 'arrived'), added,
    surface);
  if (auto) result.auto_dedupe = auto;
  // Moved rows leave the source: auto-run's fence there follows. The copies are
  // new rows in the destination, which auto-run fills when it is on there.
  // The MCP and /api/v1 answers list the auto-runs they set off (enrich-agent-autorun.ts).
  if (request.operation === 'move') {
    autorunRowsRemoved(request.sourceSheetId, userId);
    result.trash_id = trashId;
  }
  logTransfer(userId, request, preflight.matched, trashId);
  bumpDataVersion(request.destinationSheetId, userId);
  if (request.operation === 'move') bumpDataVersion(request.sourceSheetId, userId);
  result.dest_row_count = countRows(request.destinationSheetId, userId);
  checkTime();
  writeTransferLedger(userId, request.idempotencyKey, hash, result);
  return { ok: result };
}

// The change logs: the destination's, and for a move the source's too (it
// names the trash batch holding the rows as they were).
function logTransfer(userId: string, request: TransferRequest, count: number, trashId: number | null): void {
  const name = (id: string) => db.prepare('SELECT name FROM sheets WHERE id = ?').pluck().get(id) as string;
  const rows = countOf(count, 'row');
  const move = request.operation === 'move';
  if (move) {
    logSheetChange(request.sourceSheetId, userId, 'rows_moved_out',
      `Moved ${rows} to "${name(request.destinationSheetId)}"`,
      { detail: { rows: count, to_sheet_id: request.destinationSheetId, trash_id: trashId } });
  }
  logSheetChange(request.destinationSheetId, userId, 'rows_moved_in',
    `${move ? 'Moved' : 'Copied'} in ${rows} from "${name(request.sourceSheetId)}"`,
    { detail: { rows: count, from_sheet_id: request.sourceSheetId } });
}

export function transferRows(userId: string, request: TransferRequest, surface: Surface = 'rest'): TransferOutcome {
  if (!request.idempotencyKey || request.idempotencyKey.length > 200) {
    return { fail: 'invalid', error: 'idempotency_key must contain 1-200 characters.' };
  }
  if ('row_ids' in request.selection && new Set(request.selection.row_ids).size !== request.selection.row_ids.length) {
    return { fail: 'invalid', error: 'row_ids must not contain duplicates.' };
  }
  const badMapping = ([source, destination]: [string, unknown]) => !source || typeof destination !== 'string';
  if (Object.entries(request.columnMapping).some(badMapping)) {
    return { fail: 'invalid', error: 'column_mapping must map non-empty source names to destination name strings.' };
  }
  const slot = acquireTransferSlot(userId);
  if (slot !== 'ok') return {
    fail: slot,
    error: slot === 'rate'
      ? 'Too many transfer starts. Wait a minute and try again.' : 'Another transfer is already active.',
  };
  const hashes = transferHashes(request);
  try {
    return db.transaction(() => executeTransfer(userId, request, hashes, surface)).immediate();
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
