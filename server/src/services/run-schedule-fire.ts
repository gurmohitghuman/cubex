// Firing run schedules (run-schedule-store.ts): every RUN_SCHEDULE_SWEEP_MS the sweep takes the schedules due,
// moves each one's next_at on first (compare-and-set: one firing per time, even if two sweeps overlap), then fires it:
// for its sheet, or each live sheet of its table, one column run (services/column-run.ts) of its columns (or every
// run column the sheet has) on the rows it names, under its max_cost_usd, as the token or user that made it (so the
// token's spend cap, the daily enrichment limit, History and run webhooks are a column run's own). next_at comes
// from now, so a firing missed while Cubex was stopped fires once (every N hours keeps its own times). A table's
// max_cost_usd is for the whole firing: each sheet's column run gets what its estimate needs out of what is left.
// Fire now runs as the caller. What a firing couldn't start (over the ceiling, the sheet busy or in the trash, a
// column gone, the token revoked) is kept as last_error; the schedule goes on.
import { db } from '../lib/db';
import { RUN_SCHEDULE_SWEEP_MS } from '../lib/constants-setups';
import { currentActor, runAs, type Actor } from '../lib/actor';
import { micro } from '../lib/cost-ceiling';
import { getSheetColumns } from '../lib/sql-helpers';
import { sheetColumnKinds } from '../lib/column-types';
import { runColumns } from './column-run';
import {
  loadSchedule, msOf, nextAtOf, scheduleView, sqlTime, type ScheduleRow, type ScheduleView,
} from './run-schedule-store';
import type { ColumnRunInput } from './column-run-input';
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
    ? db.prepare(`SELECT s.id FROM sheets s JOIN tables t ON t.id = s.table_id WHERE s.id = ? AND s.user_id = ?
        AND s.trash_id IS NULL AND t.trash_id IS NULL`).pluck().all(s.sheet_id, s.user_id) as string[]
    : db.prepare(`SELECT s.id FROM sheets s JOIN tables t ON t.id = s.table_id WHERE t.id = ? AND t.user_id = ?
        AND s.trash_id IS NULL AND t.trash_id IS NULL ORDER BY s.position`).pluck().all(s.table_id, s.user_id) as
        string[];
}

type Run = Omit<ColumnRunInput, 'estimateOnly' | 'maxCostUsd'>;
// A sheet's share of a table firing's max_cost_usd: what max_cost_usd is checked against in its estimate (the high
// end, and one row's most for each AI column), out of what is left; a millionth of a dollar when it needs nothing now.
async function shareOf(s: ScheduleRow, sheetId: string, run: Run, left: number, secrets: boolean)
  : Promise<{ usd: number } | { error: string }> {
  const est = await runColumns(s.user_id, sheetId, { ...run, estimateOnly: true, maxCostUsd: left },
    { hasSecretsScope: secrets });
  if ('fail' in est) return { error: est.message };
  if (!('estimate' in est.ok)) return { error: 'It couldn\'t be priced.' };
  const e = est.ok.estimate;
  if (e.over_ceiling) return { error: e.ceiling_problem ?? 'It could cost more than what is left of max_cost_usd.' };
  return { usd: Math.min(left, Math.max(1, micro(e.high_usd) + micro(e.row_most_usd) + 1) / 1e6) };
}

// One sheet of a firing: its column run, the most it may spend (a table's share of max_cost_usd), and said, which
// keeps why it couldn't start (named by its sheet on a table's).
export interface FiringTurn { sheetId: string; run: Run; max: number | null; said: (message: string) => void }

// The sheets a firing takes, as it takes them: each live sheet's columns (a table's: the named ones it has), and a
// table's max_cost_usd handed out in its sheet order. go starts (or, for an estimate, prices) one sheet's column run
// and answers whether it went; a table's share is spent only then. errors: what couldn't start, and why.
export async function eachFiringSheet(s: ScheduleRow, actor: Actor, secrets: boolean,
  go: (t: FiringTurn) => Promise<boolean>): Promise<string[]> {
  const errors: string[] = [];
  const sheets = targetSheets(s);
  if (sheets.length === 0) return [`Its ${s.sheet_id ? 'sheet' : 'table'} is in the trash.`];
  const named = s.columns ? JSON.parse(s.columns) as string[] : null;
  const shared = sheets.length > 1 && s.max_cost_usd !== null;
  let left = s.max_cost_usd;
  let went = 0;
  for (const sheetId of sheets) {
    const runnable = sheetRunColumns(sheetId, s.user_id);
    // A table's schedule takes on each sheet the named columns it has; a sheet's runs what it names.
    const columns = named ? (s.table_id ? named.filter(c => runnable.includes(c)) : named) : runnable;
    if (columns.length === 0) {
      if (s.sheet_id) errors.push('The sheet has no run columns.');
      continue;
    }
    const said = (message: string) => errors.push(sheets.length > 1 ? `${sheetName(s, sheetId)}: ${message}` : message);
    const run: Run = { columns, mode: s.rows, rowIds: null, where: null, allowUnpriced: s.allow_unpriced === 1,
      webhookId: null };
    let max = left;
    if (shared) {
      if (left! <= 0) { said('The firing\'s max_cost_usd went to the sheets before it.'); continue; }
      const share = await runAs(actor, () => shareOf(s, sheetId, run, left!, secrets));
      if ('error' in share) { said(share.error); continue; }
      max = share.usd;
    }
    if (!await go({ sheetId, run, max, said })) continue;
    went++;
    if (shared) left = (micro(left!) - micro(max!)) / 1e6;
  }
  if (s.table_id && went === 0 && errors.length === 0) {
    errors.push(named ? 'No sheet of the table has these columns.' : 'No sheet of the table has a run column.');
  }
  return errors;
}

// One firing: the column runs it started, and what it couldn't start. by: fire now's caller, else whoever the
// schedule fires as (a token gone or revoked since stops it).
type By = { actor: Actor; secrets: boolean };
async function fire(s: ScheduleRow, by?: By): Promise<{ runIds: string[]; errors: string[] }> {
  const runIds: string[] = [];
  if (!by && s.access_token_id === null && s.via !== 'app') {
    return { runIds, errors: ['The access token that made it is gone.'] };
  }
  const revoked = !by && s.access_token_id && db.prepare(`SELECT revoked_at FROM access_tokens WHERE id = ?
    AND user_id = ?`).pluck().get(s.access_token_id, s.user_id);
  if (revoked) {
    return { runIds, errors: ['The access token that made it was revoked.'] };
  }
  const actor: Actor = by?.actor ?? { via: 'cubex', tokenName: s.token_name, tokenId: s.access_token_id };
  const secrets = by ? by.secrets : s.allow_secrets === 1;
  const errors = await eachFiringSheet(s, actor, secrets, async ({ sheetId, run, max, said }) => {
    const out = await runAs(actor, () => runColumns(s.user_id, sheetId,
      { ...run, estimateOnly: false, maxCostUsd: max }, { hasSecretsScope: secrets }));
    if ('fail' in out) said((out as RunFail).message);
    else if ('setup_run' in out.ok) {
      runIds.push(out.ok.setup_run.id);
      return true;
    }
    return false;
  });
  return { runIds, errors };
}
const sheetName = (s: ScheduleRow, id: string) =>
  db.prepare('SELECT name FROM sheets WHERE id = ? AND user_id = ?').pluck().get(id, s.user_id) as string;

// The next time after a firing at `now`: from now, so missed times fire once; every N hours goes on from the time it
// was due (no drift by the sweep's lateness), skipping the times missed.
function nextAfter(s: ScheduleRow, now: number): string {
  if (s.cadence !== 'hours') return nextAtOf(s, now);
  const step = s.every_hours! * 3_600_000;
  let at = msOf(s.next_at) + step;
  if (at <= now) at += Math.ceil((now - at + 1) / step) * step;
  return sqlTime(at);
}

// Takes the firing (moves next_at on from now) unless another sweep did; then fires and keeps what happened.
async function claimAndFire(s: ScheduleRow, now: number, by?: By): Promise<void> {
  if (!by) {
    const taken = db.prepare(`UPDATE run_schedules SET next_at = ? WHERE id = ? AND next_at = ? AND paused = 0`)
      .run(nextAfter(s, now), s.id, s.next_at).changes > 0;
    if (!taken) return;
  }
  let result: { runIds: string[]; errors: string[] };
  try { result = await fire(s, by); } catch (err) {
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
    for (const s of due) await claimAndFire(s, now);
    return due.length;
  } finally { sweeping = false; }
}

// "Fire now" (fire_now): once, at once, as the caller (its spend cap, its saved keys); its next time stays as it was.
export async function fireScheduleNow(userId: string, id: string, caller: { hasSecretsScope: boolean })
  : Promise<{ ok: ScheduleView } | RunFail> {
  const s = loadSchedule(userId, id);
  if (!s) return { fail: 'not_found', message: 'Schedule not found' };
  await claimAndFire(s, Date.now(), { actor: currentActor(), secrets: caller.hasSecretsScope });
  return { ok: scheduleView(loadSchedule(userId, id)!) };
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startRunScheduleLoop(): void {
  if (timer) return;
  timer = setInterval(() => { void sweepRunSchedules(); }, RUN_SCHEDULE_SWEEP_MS);
  timer.unref?.();
}
