// Firing run schedules (run-schedule-store.ts): every RUN_SCHEDULE_SWEEP_MS the sweep takes the schedules due,
// moves each one's next_at on first (compare-and-set: one firing per time, even if two sweeps overlap), then fires it:
// for its sheet, or each live sheet of its table, one column run (services/column-run.ts) of its columns (or every
// run column the sheet has) on the rows it names, under its max_cost_usd, as the token or user that made it (so the
// token's spend cap, the daily enrichment limit, History and run webhooks are a column run's own). next_at comes
// from now, so a firing missed while Cubex was stopped fires once. What a firing couldn't start (over the ceiling,
// the sheet busy or in the trash, a column gone, the token revoked) is kept as last_error; the schedule goes on.
import { db } from '../lib/db';
import { RUN_SCHEDULE_SWEEP_MS } from '../lib/constants-setups';
import { runAs, type Actor } from '../lib/actor';
import { getSheetColumns } from '../lib/sql-helpers';
import { sheetColumnKinds } from '../lib/column-types';
import { runColumns } from './column-run';
import {
  loadSchedule, nextAtOf, scheduleView, sqlTime, type ScheduleRow, type ScheduleView,
} from './run-schedule-store';
import type { RunFail } from './run-shared';

const RUN_KINDS = new Set(['ai-output', 'http-master', 'enrich-status', 'waterfall']);

// Every run column a sheet has (an AI, HTTP API, enrichment or waterfall run's main column), in its order.
export function sheetRunColumns(sheetId: string, userId: string): string[] {
  const kinds = sheetColumnKinds(sheetId, userId).types;
  return getSheetColumns(sheetId, userId, false).filter(c => RUN_KINDS.has(kinds[c] ?? ''));
}

// The live sheets a schedule fires on: its sheet, or its table's, none in the trash.
function targetSheets(s: ScheduleRow): string[] {
  return s.sheet_id
    ? db.prepare(`SELECT s.id FROM sheets s JOIN tables t ON t.id = s.table_id WHERE s.id = ? AND s.trash_id IS NULL
        AND t.trash_id IS NULL`).pluck().all(s.sheet_id) as string[]
    : db.prepare(`SELECT s.id FROM sheets s JOIN tables t ON t.id = s.table_id WHERE t.id = ? AND s.trash_id IS NULL
        AND t.trash_id IS NULL ORDER BY s.position`).pluck().all(s.table_id) as string[];
}

// One firing: the column runs it started, and what it couldn't start.
async function fire(s: ScheduleRow): Promise<{ runIds: string[]; errors: string[] }> {
  const runIds: string[] = [];
  const errors: string[] = [];
  if (s.access_token_id === null && s.via !== 'app') {
    return { runIds, errors: ['The access token that made it is gone.'] };
  }
  const revoked = s.access_token_id
    && db.prepare('SELECT revoked_at FROM access_tokens WHERE id = ?').pluck().get(s.access_token_id);
  if (revoked) {
    return { runIds, errors: ['The access token that made it was revoked.'] };
  }
  const sheets = targetSheets(s);
  if (sheets.length === 0) return { runIds, errors: [`Its ${s.sheet_id ? 'sheet' : 'table'} is in the trash.`] };
  const actor: Actor = { via: 'cubex', tokenName: s.token_name, tokenId: s.access_token_id };
  const named = s.columns ? JSON.parse(s.columns) as string[] : null;
  for (const sheetId of sheets) {
    const runnable = sheetRunColumns(sheetId, s.user_id);
    // A table's schedule takes on each sheet the named columns it has; a sheet's runs what it names.
    const columns = named ? (s.table_id ? named.filter(c => runnable.includes(c)) : named) : runnable;
    if (columns.length === 0) {
      if (s.sheet_id) errors.push('The sheet has no run columns.');
      continue;
    }
    const out = await runAs(actor, () => runColumns(s.user_id, sheetId, {
      columns, mode: s.rows, rowIds: null, where: null, estimateOnly: false, maxCostUsd: s.max_cost_usd,
      allowUnpriced: s.allow_unpriced === 1, webhookId: null,
    }, { hasSecretsScope: s.allow_secrets === 1 }));
    if ('fail' in out) {
      errors.push(sheets.length > 1 ? `${sheetName(sheetId)}: ${(out as RunFail).message}` : out.message);
    }
    else if ('setup_run' in out.ok) runIds.push(out.ok.setup_run.id);
  }
  return { runIds, errors };
}
const sheetName = (id: string) => db.prepare('SELECT name FROM sheets WHERE id = ?').pluck().get(id) as string;

// Takes the firing (moves next_at on from now) unless another sweep did; then fires and keeps what happened.
async function claimAndFire(s: ScheduleRow, now: number, moveOn: boolean): Promise<void> {
  if (moveOn) {
    const taken = db.prepare(`UPDATE run_schedules SET next_at = ? WHERE id = ? AND next_at = ? AND paused = 0`)
      .run(nextAtOf(s, now), s.id, s.next_at).changes > 0;
    if (!taken) return;
  }
  let result: { runIds: string[]; errors: string[] };
  try { result = await fire(s); } catch (err) {
    console.error(`Run schedule ${s.id} couldn't fire:`, err);
    result = { runIds: [], errors: ['It couldn\'t start: Cubex hit an error. It fires again next time.'] };
  }
  db.prepare(`UPDATE run_schedules SET last_fired_at = ?, last_run_ids = ?, last_error = ?, updated_at = datetime('now')
    WHERE id = ?`).run(sqlTime(now), JSON.stringify(result.runIds),
    result.errors.length ? result.errors.join(' ') : null, s.id);
}

let sweeping = false;
export async function sweepRunSchedules(now = Date.now()): Promise<number> {
  if (sweeping) return 0;
  sweeping = true;
  try {
    const due = db.prepare(`SELECT * FROM run_schedules WHERE paused = 0 AND next_at <= ? ORDER BY next_at LIMIT 50`)
      .all(sqlTime(now)) as ScheduleRow[];
    for (const s of due) await claimAndFire(s, now, true);
    return due.length;
  } finally { sweeping = false; }
}

// "Fire now" (fire_now): once, at once; its next time stays as it was.
export async function fireScheduleNow(userId: string, id: string): Promise<{ ok: ScheduleView } | RunFail> {
  const s = loadSchedule(userId, id);
  if (!s) return { fail: 'not_found', message: 'Schedule not found' };
  await claimAndFire(s, Date.now(), false);
  return { ok: scheduleView(loadSchedule(userId, id)!) };
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startRunScheduleLoop(): void {
  if (timer) return;
  timer = setInterval(() => { void sweepRunSchedules(); }, RUN_SCHEDULE_SWEEP_MS);
  timer.unref?.();
}
