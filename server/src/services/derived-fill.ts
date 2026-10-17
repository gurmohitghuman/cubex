// Filling a derived column (derived-kind.ts: a clean or a formula column):
// each row worked out from its inputs, with no request and no cost. It runs
// with the sheet busy (lib/sheet-busy.ts), so no edit lands between a row's
// read and its write, in storage (rowid) order (lib/row-order.ts): each slice
// reads its rows, writes the cells that change and moves the cursor in one
// short transaction. A restart goes on from the cursor (resumeDerivedFills at
// boot). Writes are idempotent; a slice that fails is retried a few times,
// then the fill ends as failed and frees the sheet, as it does when the kind
// stops the pass (a formula too slow). A pass that has to wait (a lookup whose
// other sheet is sorting) ends the attempt with the column still filling and
// the cursor kept: the sheet is free meanwhile, and the fill takes it again
// once the pass can go on. Every read shows the column as processing until
// the fill is done (lib/field-fill-columns.ts).
import { db } from '../lib/db';
import { HEAVY_SLICE_ROWS, LOOKUP_WAIT_POLL_MS } from '../lib/constants';
import { jsonPath } from '../lib/sql-rows';
import { sheetRowIds } from '../lib/row-order';
import { yieldToRequests } from '../lib/slices';
import { stayBusyToFinish, whenSheetFree } from '../lib/sheet-busy';
import { markAutorunInputs } from '../lib/autorun-mark';
import { redactSecrets } from '../lib/redact';
import type { DerivedKind, DerivedRecord, DerivedWait } from './derived-kind';
import { asDerivedRead, derivedSelect, pageAfter, readDerivedRows, writeDerivedCells } from './derived-write';

const FILL_ATTEMPTS = 5;

// Returns what the pass waits for when it has to stop before the end, else null.
async function work<R extends DerivedRecord>(kind: DerivedKind<R>, job: R): Promise<DerivedWait | null> {
  const pass = await kind.open(job, 'fill');
  if ('error' in pass) {
    finishFill(kind, job, 'failed', pass.error);
    return null;
  }
  try {
    const inputs = kind.inputs(job);
    const all = await sheetRowIds(job.sheet_id, job.user_id);
    const rowIds = job.fill_cursor > 0 ? all.filter(id => id > job.fill_cursor) : all;
    const sel = derivedSelect(job.column_name, inputs);
    const stmt = db.prepare(`SELECT rowid AS rowid, row_index AS i, ${sel.sql}
      FROM rows WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ? ORDER BY rowid`);
    const cellPath = jsonPath(job.column_name);
    let page = HEAVY_SLICE_ROWS;
    for (let at = 0; at < rowIds.length;) {
      await pass.prepare();
      const waitBefore = pass.waiting?.();
      if (waitBefore) return waitBefore;
      let stopped = false;
      let next = at;
      db.transaction(() => {
        // Edited, or started again meanwhile (an agent's second call): this fill is over.
        const now = kind.load(job.id);
        if (!now || now.fill_status !== 'filling' || !kind.sameSetup(now, job)) {
          stopped = true;
          return;
        }
        const end = Math.min(rowIds.length, at + page);
        const ids = JSON.stringify(Array.from(rowIds.subarray(at, end)));
        const read = readDerivedRows(stmt.iterate(...sel.params, ids, job.sheet_id, job.user_id), page, inputs.length);
        const rows = read.rows.map(r => asDerivedRead(r, inputs.length));
        const counts = writeDerivedCells(job.user_id, cellPath, rows, pass);
        // A column another column's auto-run reads queues these rows for it.
        markAutorunInputs(job.sheet_id, job.user_id, [job.column_name], { rowids: counts.changed });
        // The slice may end early (time, a pass to prepare, the read cut short):
        // the cursor moves past the rows it worked out, and past deleted rows
        // once every row of the chunk was read and worked out.
        if (counts.done < rows.length) next = rowIds.indexOf(rows[counts.done].rowid, at);
        else if (read.capped && rows.length > 0) next = rowIds.indexOf(rows[rows.length - 1].rowid, at) + 1;
        else next = end;
        if (next > at) kind.advance(job, rowIds[next - 1], counts);
        page = pageAfter(page, rows.length, counts.done);
      }).immediate();
      if (stopped) return null;
      const failure = pass.failure();
      if (failure) {
        finishFill(kind, job, 'failed', failure);
        return null;
      }
      const waitAfter = pass.waiting?.();
      if (waitAfter) return waitAfter;
      at = next;
      await yieldToRequests();
    }
    finishFill(kind, job, 'done', null);
    return null;
  } finally {
    pass.dispose();
  }
}

function finishFill<R extends DerivedRecord>(
  kind: DerivedKind<R>, job: R, status: 'done' | 'failed', error: string | null,
): void {
  db.transaction(() => {
    db.prepare(`UPDATE ${kind.table} SET fill_status = ?, error_message = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND fill_status = 'filling'`).run(status, error, job.id, job.user_id);
    // Open tabs reload and the column's ⏳ give way to its values.
    db.prepare(`UPDATE sheets SET data_version = data_version + 1, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?`).run(job.sheet_id, job.user_id);
  }).immediate();
}

// Fills waiting for their pass to go on: what each waits for (the column's view says so).
const waits = new Map<string, DerivedWait>();
export const derivedFillWait = (id: string): string | null => waits.get(id)?.note ?? null;

// Takes the sheet again once the pass can go on (polls; one waiter per fill).
function resumeWhenReady<R extends DerivedRecord>(kind: DerivedKind<R>, job: R, wait: DerivedWait): void {
  if (waits.has(job.id)) { waits.set(job.id, wait); return; }
  waits.set(job.id, wait);
  const poll = () => {
    let go: boolean;
    try {
      const still = kind.load(job.id);
      if (!still || still.fill_status !== 'filling') { waits.delete(job.id); return; }
      go = waits.get(job.id)!.ready();
    } catch (err) {
      console.error(`Checking whether the ${kind.noun} fill on sheet ${job.sheet_id} can go on failed:`, err);
      go = false;
    }
    if (!go) { setTimeout(poll, LOOKUP_WAIT_POLL_MS).unref?.(); return; }
    waits.delete(job.id);
    whenSheetFree(job.sheet_id, kind.busy, () => runDerivedFill(kind, job.id))
      .catch(err => console.error(`Resuming the ${kind.noun} fill on sheet ${job.sheet_id} failed:`, err));
  };
  setTimeout(poll, LOOKUP_WAIT_POLL_MS).unref?.();
}

// Runs (or resumes) the fill as the sheet's heavy operation; call inside it.
export async function runDerivedFill<R extends DerivedRecord>(kind: DerivedKind<R>, id: string): Promise<void> {
  const job = kind.load(id);
  if (!job || job.fill_status !== 'filling') return;
  try {
    const wait = await work(kind, job);
    if (wait) resumeWhenReady(kind, job, wait);
  } catch (err) {
    console.error(`Filling ${kind.noun} "${job.column_name}" on sheet ${job.sheet_id} failed, retrying:`, err);
    let attempts = 1;
    stayBusyToFinish(job.sheet_id, kind.busy, async () => {
      const again = kind.load(id);
      if (!again || again.fill_status !== 'filling') return;
      try {
        const wait = await work(kind, again);
        if (wait) resumeWhenReady(kind, again, wait);
      } catch (e) {
        if (++attempts < FILL_ATTEMPTS) throw e;
        console.error(`Filling ${kind.noun} "${job.column_name}" on sheet ${job.sheet_id} gave up:`, e);
        finishFill(kind, again, 'failed', redactSecrets(String((e as Error)?.message ?? e)).slice(0, 500));
      }
    });
  }
}

// At boot, before serving: every unfinished fill marks its sheet busy at once.
export function resumeDerivedFills<R extends DerivedRecord>(kind: DerivedKind<R>): void {
  const jobs = db.prepare(`SELECT id, sheet_id FROM ${kind.table} WHERE fill_status = 'filling'
    ORDER BY updated_at`).all() as Array<{ id: string; sheet_id: string }>;
  for (const j of jobs) {
    whenSheetFree(j.sheet_id, kind.busy, () => runDerivedFill(kind, j.id))
      .catch(err => console.error(`Finishing the ${kind.noun} fill on sheet ${j.sheet_id} failed:`, err));
  }
}

// An answer that waits for the fill, up to `ms` (it polls the record, so a
// fill resumed at boot counts too).
export async function waitForDerivedFill<R extends DerivedRecord>(
  kind: DerivedKind<R>, id: string, ms: number,
): Promise<R | undefined> {
  const until = Date.now() + ms;
  for (;;) {
    const row = kind.load(id);
    if (!row || row.fill_status !== 'filling' || Date.now() >= until) return row;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
