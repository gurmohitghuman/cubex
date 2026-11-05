// Row writes with an idempotency key: MCP append_rows and update_cells and
// their /api/v1 routes. The same key with the same arguments returns the first
// answer (replayed: true) and writes nothing; with other arguments it's
// refused. The ledger check, the rows and the ledger entry go in ONE immediate
// transaction (lib/write-idempotency.ts), the plain services nested inside it.
// Without a key the routes and tools call the plain services, unchanged.
import { db } from '../lib/db';
import { IDEMPOTENT_WRITE_KEY_MAX_CHARS, IDEMPOTENT_WRITE_ROW_BYTES } from '../lib/api-v1-constants';
import { readWriteLedger, writeRequestHash, writeWriteLedger } from '../lib/write-idempotency';
import { appendAnswer, appendRows, patchAnswer, patchRowById } from './rows-write';
import { batchUpdateRows, type BatchUpdate } from './rows-batch-update';
import type { TxnFail } from './data-plane-shared';
import type { AutoDedupeAnswer } from './auto-dedupe-answer';
import type { Surface } from './trash-answer';

export type Keyed<T> = { ok: T; replayed: boolean } | TxnFail;

// undefined: no key. Run starts check theirs the same way (run-start-token.ts).
export function idempotencyKeyOf(raw: unknown): { key?: string } | { error: string } {
  if (raw === undefined) return {};
  if (typeof raw !== 'string' || !raw || raw.length > IDEMPOTENT_WRITE_KEY_MAX_CHARS) {
    return { error: `idempotency_key must be a string of 1-${IDEMPOTENT_WRITE_KEY_MAX_CHARS} characters` };
  }
  return { key: raw };
}

// An append's answer, compact: its row ids in order, the first one's index
// (they're consecutive), the positions auto-dedupe didn't keep, and its
// auto_dedupe part (bounded: at most AUTO_DEDUPE_LIST_IDS of each list).
// About 40 bytes a row: 1,000 rows stay well under 64 KB.
interface StoredAppend { ids: string[]; first: number; not_kept: number[]; auto_dedupe?: AutoDedupeAnswer }

const appendReplay = (s: StoredAppend): Record<string, unknown> => {
  const out = new Set(s.not_kept);
  return {
    rows: s.ids.map((id, i) => (out.has(i) ? { id, index: s.first + i, kept: false } : { id, index: s.first + i })),
    ...(s.auto_dedupe ? { auto_dedupe: s.auto_dedupe } : {}),
  };
};

// kept: how many of the rows stayed (for the auto-run notice of a first call).
export function appendRowsKeyed(
  sheetId: string, userId: string, parsedRows: Array<Record<string, string>>, key: string, surface: Surface,
): Keyed<{ answer: Record<string, unknown>; kept: number }> {
  const hash = writeRequestHash('rows_append', { sheet_id: sheetId, rows: parsedRows });
  return db.transaction((): Keyed<{ answer: Record<string, unknown>; kept: number }> => {
    const prior = readWriteLedger<StoredAppend>(userId, key, hash);
    if (prior) {
      return 'conflict' in prior ? { fail: 'idempotency_conflict' }
        : { ok: { answer: appendReplay(prior.replay), kept: 0 }, replayed: true };
    }
    const done = appendRows(sheetId, userId, parsedRows);
    if ('fail' in done) return done;
    const answer = appendAnswer(userId, done.ok, surface);
    const rows = done.ok.rows;
    writeWriteLedger(userId, key, 'rows_append', hash, {
      ids: rows.map(r => r.id), first: rows[0]?.index ?? 0,
      not_kept: rows.flatMap((r, i) => (done.ok.notKept.has(r.id) ? [i] : [])),
      ...(answer.auto_dedupe ? { auto_dedupe: answer.auto_dedupe as AutoDedupeAnswer } : {}),
    } satisfies StoredAppend);
    return { ok: { answer, kept: done.ok.kept }, replayed: false };
  }).immediate();
}

// A one-row update's answer, and the row's sheet: the row id names it, so a
// call with or without sheet_id is the same call, and one naming another
// sheet is a different one. Cells over IDEMPOTENT_WRITE_ROW_BYTES aren't kept.
interface StoredPatch { sheet_id: string; answer: Record<string, unknown> }

function keptPatch(answer: Record<string, unknown>): Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(answer.data ?? null), 'utf8') <= IDEMPOTENT_WRITE_ROW_BYTES) return answer;
  const { data: _data, ...rest } = answer;
  return {
    ...rest, data_left_out: true,
    note: `A replay leaves out the row's cells (over ${IDEMPOTENT_WRITE_ROW_BYTES / 1024} KB): `
      + 'read the row to see them.',
  };
}

// not_in_sheet: sheet_id was given and the row isn't in it.
export function patchRowKeyed(
  rowId: string, userId: string, cells: Record<string, string>, sheetId: string | undefined, key: string,
  surface: Surface,
): Keyed<Record<string, unknown>> | { fail: 'not_in_sheet' } {
  const hash = writeRequestHash('cells_update', { row_id: rowId, cells });
  return db.transaction((): Keyed<Record<string, unknown>> | { fail: 'not_in_sheet' } => {
    const prior = readWriteLedger<StoredPatch>(userId, key, hash, s => sheetId === undefined || s.sheet_id === sheetId);
    if (prior) {
      return 'conflict' in prior ? { fail: 'idempotency_conflict' } : { ok: prior.replay.answer, replayed: true };
    }
    const home = db.prepare('SELECT sheet_id FROM rows WHERE id = ? AND user_id = ?').pluck()
      .get(rowId, userId) as string | undefined;
    if (home === undefined) return { fail: 'not_found' };
    if (sheetId !== undefined && home !== sheetId) return { fail: 'not_in_sheet' };
    const done = patchRowById(rowId, userId, cells);
    if ('fail' in done) return done;
    const answer = patchAnswer(userId, done.ok, surface);
    writeWriteLedger(userId, key, 'cells_update', hash, { sheet_id: home, answer: keptPatch(answer) });
    return { ok: answer, replayed: false };
  }).immediate();
}

type BatchAnswer = { updated: number; auto_dedupe?: AutoDedupeAnswer };

// The updates' order changes nothing they write, so it doesn't change the call either.
export function batchUpdateKeyed(
  sheetId: string, userId: string, updates: BatchUpdate[], key: string, surface: Surface,
): Keyed<BatchAnswer> | { fail: 'duplicate_rows' } {
  if (new Set(updates.map(u => u.rowId)).size !== updates.length) return { fail: 'duplicate_rows' };
  const sorted = [...updates].sort((a, b) => (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0));
  const hash = writeRequestHash('cells_update_batch', {
    sheet_id: sheetId, updates: sorted.map(u => ({ row_id: u.rowId, cells: u.cells })),
  });
  return db.transaction((): Keyed<BatchAnswer> | { fail: 'duplicate_rows' } => {
    const prior = readWriteLedger<BatchAnswer>(userId, key, hash);
    if (prior) return 'conflict' in prior ? { fail: 'idempotency_conflict' } : { ok: prior.replay, replayed: true };
    const done = batchUpdateRows(sheetId, userId, updates, surface);
    if ('fail' in done) return done;
    writeWriteLedger(userId, key, 'cells_update_batch', hash, done.ok);
    return { ok: done.ok, replayed: false };
  }).immediate();
}
