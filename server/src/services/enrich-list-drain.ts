// List results into rows: the API-process loop (every ENRICH_LIST_DRAIN_MS)
// that adds journaled results (enrichment_list_items) as rows. Workers can't
// append: the busy lock and the append floor live in this process. Each round
// goes destination by destination, so one that has to wait never holds
// another's rows. Each source row's rows go in one synchronous transaction, a
// slice of the round's bulk writer (its WAL copied back on the checkpoint
// worker's thread: lib/bulk-slices.ts), checked in it against a sort, an import
// or a column change on either sheet (lib/sheet-busy.ts); the loop never holds the sheets itself, so a run
// start or a pick of fields there is never refused as busy. Per destination
// they go oldest first: one that has to wait (for room, for its source sheet
// to be free) holds the ones after it, so a rerun's newer rows never land
// before older ones. One that waits for a run on that sheet steps aside (only
// a newer one of its own source row waits behind it): tried again each round,
// or, behind a paused run, set aside until that run is resumed or ends
// (services/enrich-list-dest-run.ts). One that keeps failing is
// marked failed after a few tries (its results kept) and its row says why.
// Started at boot (lib/server-lifecycle.ts), so rows still pending at a restart are added.
// Deleting a source sheet drops its results not added yet (the journal goes
// with the sheet, as its rows and their status cells do).
import { db } from '../lib/db';
import { ENRICH_LIST_DRAIN_ATTEMPTS, ENRICH_LIST_DRAIN_BATCH, ENRICH_LIST_DRAIN_MS } from '../lib/constants';
import { sheetBusyWith } from '../lib/sheet-busy';
import { asBulkWriter, type BulkWriter } from '../lib/bulk-slices';
import { failedCell } from '../lib/enrich-cells';
import { redactError, redactSecrets } from '../lib/redact';
import { addListItemsIn, stopAfterAdd, type AddOutcome, type DestCount } from './enrich-list-add';
import { waitForRoom, writeSourceCell } from './enrich-list-source';
import { releaseDestRunWaits } from './enrich-list-dest-run';

interface Pending { id: string; source_sheet_id: string; source_row_id: string; item_count: number }

// Results of a test whose fields were picked while it still ran: its worker
// journaled them as waiting, and they can go now.
function releasePicked(): void {
  // Read first: an update takes the write lock even when it matches nothing, and this runs every round.
  if (!db.prepare(`SELECT 1 FROM enrichment_list_items WHERE status = 'pending' AND wait_reason = 'fields'
    LIMIT 1`).get()) return;
  db.prepare(`UPDATE enrichment_list_items SET wait_reason = NULL, updated_at = datetime('now')
    WHERE status = 'pending' AND wait_reason = 'fields' AND run_id IN (
      SELECT id FROM http_runs WHERE id IN (SELECT run_id FROM enrichment_list_items
        WHERE status = 'pending' AND wait_reason = 'fields')
      AND IFNULL(json_array_length(config, '$.enrichment.list.fields'), 0) > 0)`).run();
}

// A journal row that failed too often: kept as failed with its results (they
// were paid for), and its source row says why.
function giveUp(id: string, error: unknown): void {
  const reason = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200);
  db.transaction(() => {
    const j = db.prepare(`SELECT li.id, li.user_id, li.run_id, li.source_sheet_id, li.source_row_id,
        r.master_column_name AS column FROM enrichment_list_items li JOIN http_runs r ON r.id = li.run_id
      WHERE li.id = ? AND li.status = 'pending'`).get(id) as {
        id: string; user_id: string; run_id: string; source_sheet_id: string; source_row_id: string;
        column: string | null;
      } | undefined;
    if (!j) return;
    db.prepare(`UPDATE enrichment_list_items SET status = 'failed', error_message = ?, updated_at = datetime('now')
      WHERE id = ?`).run(reason, id);
    writeSourceCell(j, j.column, failedCell(`Rows not added: ${reason}`));
  }).immediate();
}

// The database busy, locked, full or failing to write: not this journal row's
// fault, so it's tried again without counting.
const TRANSIENT = /^SQLITE_(BUSY|LOCKED|FULL|IOERR)/;

// One journal row's rows in one slice, unless either sheet is busy then ('busy'). A failed add is
// rolled back with its slice, then counted here.
async function tryAdd(w: BulkWriter, id: string, sourceSheet: string, dest: string, count: DestCount):
  Promise<AddOutcome | { error: true } | 'busy'> {
  try {
    const done = await w.slice(() =>
      (sheetBusyWith(dest) || sheetBusyWith(sourceSheet) ? null : addListItemsIn(id, count)));
    if (!done) return 'busy';
    if (done.stop) stopAfterAdd(done.stop);
    return done.out;
  } catch (error) {
    console.error(`Adding list results ${id} as rows failed:`, redactError(error));
    count.rows = null;
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && TRANSIENT.test(code)) return { error: true };
    const tries = db.prepare(`UPDATE enrichment_list_items SET attempts = attempts + 1, updated_at = datetime('now')
      WHERE id = ? RETURNING attempts`).pluck().get(id) as number | undefined;
    if ((tries ?? 0) >= ENRICH_LIST_DRAIN_ATTEMPTS) giveUp(id, error);
    return { error: true };
  }
}

let draining = false;

export async function drainListItems(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    releasePicked();
    releaseDestRunWaits();
    // A sheet in the trash takes no rows (its items went with it: trash-sheets.ts).
    const dests = db.prepare(`SELECT DISTINCT dest_sheet_id FROM enrichment_list_items
      WHERE status = 'pending' AND (wait_reason IS NULL OR wait_reason = 'room')
        AND dest_sheet_id IN (SELECT id FROM sheets WHERE trash_id IS NULL)`).pluck().all() as string[];
    if (dests.length === 0) return;
    await asBulkWriter(async w => {
      for (const dest of dests) {
        const items = db.prepare(`SELECT id, source_sheet_id, source_row_id, item_count FROM enrichment_list_items
          WHERE rowid IN (
            SELECT rowid FROM enrichment_list_items WHERE dest_sheet_id = ? AND status = 'pending'
              AND (wait_reason IS NULL OR wait_reason = 'room') ORDER BY created_at, rowid LIMIT ?)
          ORDER BY created_at, rowid`).all(dest, ENRICH_LIST_DRAIN_BATCH) as Pending[];
        const count: DestCount = { rows: null };
        for (const [i, item] of items.entries()) {
          const out = await tryAdd(w, item.id, item.source_sheet_id, dest, count);
          // A sort, an import or a column change on either sheet: the next round goes on.
          if (out === 'busy') break;
          // The ones behind a full sheet wait for room as well, but a removal with
          // nothing of its row ahead goes on (it makes room).
          if ('wait' in out && out.wait === 'room') {
            const ahead = new Set(items.slice(0, i + 1).map(x => x.source_row_id));
            for (const behind of items.slice(i + 1)) {
              const removal = behind.item_count === 0 && !ahead.has(behind.source_row_id);
              if (!removal || await tryAdd(w, behind.id, behind.source_sheet_id, dest, count) === 'busy') {
                waitForRoom(behind.id);
                ahead.add(behind.source_row_id);
              }
            }
          }
          if ('error' in out || ('wait' in out && out.wait === 'room')) break;
        }
      }
    });
  } finally {
    draining = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startListDrainLoop(): void {
  if (timer) return;
  void drainListItems().catch(err => console.error('Adding list results as rows failed this round:', err));
  timer = setInterval(() => {
    void drainListItems().catch(err => console.error('Adding list results as rows failed this round:', err));
  }, ENRICH_LIST_DRAIN_MS);
  timer.unref?.();
}
