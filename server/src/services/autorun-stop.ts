// How auto-run runs end (worker threads and the API process both call these).
// A run a person started pauses at a stop, rows still ⏳, until they fix it and
// Resume. An auto-run run cancels itself instead: a paused run counts as
// active, so it would hold the sheet's sort, row deletes and edits until
// someone came by. Its rows that didn't run go back in the queue, the column's
// auto-run pauses with the reason (cleared on its own for the stops that can
// clear: midnight UTC, a key fix, treg reachable again), and its ⏳ cells clear.
import { db } from '../lib/db';
import { redactSecrets } from '../lib/redact';
import { jsonPath } from '../lib/sql-rows';
import { PLACEHOLDER } from '../lib/placeholder-cells';
import { clearRunPlaceholders } from '../lib/run-placeholders';
import { parseTargetRows } from '../lib/run-targets';
import { loadEntry, pauseEntry } from './autorun-entry';
import { UNCAPPED_BILLED_NOTE } from '../lib/enrich-estimate';
import { getDailyLimitMicro } from './treg-key';
import type { HTTPRunRow } from './http-runner-status';

const money = (usd: number) => `$${usd >= 0.01 || usd === 0 ? usd.toFixed(2) : usd.toFixed(4)}`;

const bumpDataVersion = (sheetId: string, userId: string) => db.prepare(
  'UPDATE sheets SET data_version = data_version + 1 WHERE id = ? AND user_id = ?',
).run(sheetId, userId);

// The words the column's auto-run shows for a run-level stop. Today's caps
// leave out when it goes on: the grid says so in the reader's own time. A run
// with no per-row cap keeps its note on what stopped it (as autorun-capacity.ts).
function entryReason(
  run: HTTPRunRow, entryId: string, reason: string, message: string,
): { reason: string; message: string } {
  const billed = message.includes(UNCAPPED_BILLED_NOTE) ? ` ${UNCAPPED_BILLED_NOTE}` : '';
  if (reason === 'spend_limit') {
    const cap = loadEntry(entryId)?.daily_cap_micro ?? 0;
    return { reason: 'column_cap', message: `It reached today's ${money(cap / 1e6)} cap for this column.${billed}` };
  }
  if (reason === 'daily_limit') {
    const limit = getDailyLimitMicro(run.user_id) ?? 0;
    return { reason, message: `Today's ${money(limit / 1e6)} enrichment limit is reached.${billed}` };
  }
  // Lifted by the tick once the token that turned auto-run on has room again (autorun-loop.ts).
  if (reason === 'token_cap') return { reason, message: `${message} Auto-run goes on by itself once it is raised.` };
  return { reason, message };
}

// Rows of a run that still hold ⏳ didn't run: back in the queue for the next auto-run.
export function requeueUnfinished(
  entryId: string, sheetId: string, userId: string, statusColumn: string | null, targets: number[] | null,
): void {
  if (!statusColumn || !targets?.length) return;
  db.prepare(`INSERT OR IGNORE INTO autorun_pending (autorun_id, user_id, row_id)
    SELECT ?, user_id, id FROM rows WHERE sheet_id = ? AND user_id = ?
      AND row_index IN (SELECT value FROM json_each(?)) AND json_extract(data, ?) = ?`)
    .run(entryId, sheetId, userId, JSON.stringify(targets), jsonPath(statusColumn), PLACEHOLDER);
}

export async function stopAutorunRun(
  run: HTTPRunRow, generation: number, reason: string, raw: string, targets: number[] | null,
): Promise<void> {
  const entryId = run.autorun_id;
  if (!entryId) return;
  // treg's own detail text can ride along: redacted before the run keeps it (as failHTTPRun).
  const message = redactSecrets(raw);
  const stop = entryReason(run, entryId, reason, message);
  const stopped = db.transaction(() => {
    const r = db.prepare(`UPDATE http_runs SET status = 'cancelled', placeholder_work = 'clearing', pause_reason = ?,
        error_message = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'running' AND worker_generation = ?`)
      .run(reason, message.slice(0, 500), run.id, generation);
    if (r.changes === 0) return false;
    requeueUnfinished(entryId, run.sheet_id, run.user_id, run.master_column_name, targets);
    pauseEntry(entryId, stop.reason, stop.message);
    bumpDataVersion(run.sheet_id, run.user_id);
    return true;
  }).immediate();
  if (stopped) await clearRunPlaceholders('http', run.id);
}

// A run that failed (finalize found rows it couldn't process, or the worker
// threw): its auto-run pauses rather than try the same thing every sweep. An
// enrichment's unfinished rows wait in the queue for when it is resumed (their
// treg keys replay a paid answer for free). An HTTP column's are left empty:
// one may have sent its request already, and sending it again could add a
// lead twice. Call before the run's ⏳ cells are cleared.
export function autorunRunFailed(
  run: Pick<HTTPRunRow, 'autorun_id' | 'sheet_id' | 'user_id' | 'master_column_name' | 'target_rows'>,
  reason: string,
): void {
  if (!run.autorun_id) return;
  const http = loadEntry(run.autorun_id)?.kind === 'http';
  if (!http) {
    const targets = parseTargetRows(run.target_rows);
    requeueUnfinished(run.autorun_id, run.sheet_id, run.user_id, run.master_column_name, targets);
  }
  const left = http ? " Rows it didn't finish are left empty: some may have sent their request, so run them by "
    + 'hand only if needed.' : '';
  const why = reason.trim().replace(/[.!?]?$/, '.');
  pauseEntry(run.autorun_id, 'failed', `The last auto-run failed: ${why}${left}`);
  bumpDataVersion(run.sheet_id, run.user_id);
}

// A run that finished: open tabs reload to show it (auto-run runs no one is
// streaming are seen through the change poll).
export function autorunRunEnded(run: Pick<HTTPRunRow, 'autorun_id' | 'sheet_id' | 'user_id'>): void {
  if (run.autorun_id) bumpDataVersion(run.sheet_id, run.user_id);
}

// A person stopped an auto-run run: that column's auto-run stays paused (its
// rows aren't picked up again) until they turn it back on.
export function autorunStoppedByUser(run: { autorun_id?: string | null }): void {
  if (!run.autorun_id) return;
  db.prepare(`UPDATE autorun_columns SET paused_reason = 'user', paused_message = ?, paused_at = datetime('now'),
      updated_at = datetime('now') WHERE id = ?`)
    .run('You stopped its run. Resume it to go on.', run.autorun_id);
}
