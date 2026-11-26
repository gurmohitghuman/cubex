// Over 200 lines: one schedule record's checks, owner and changes, read together.
// Run schedules (migration 069): one implementation for the app, /api/v1 and MCP's manage_run_schedule. A schedule
// reruns a sheet's run columns (or a table's, each sheet's) on a cadence (lib/run-schedule-time.ts); the sweep
// (run-schedule-fire.ts) fires it as an ordinary column run, as the token or user that made it. Creating one, and
// changing its time, works out next_at from now; resuming one does too, so a paused schedule doesn't fire at once
// for the time it was paused. At most RUN_SCHEDULES_PER_TARGET on one sheet or table. A schedule fires as whoever
// made it, or last changed or resumed it (as a run you resume becomes yours): its firings count toward that token's
// spend cap, and read saved keys only when that caller could.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { RUN_SCHEDULES_PER_TARGET } from '../lib/constants-setups';
import { CADENCES, nextFireAt, scheduleTimeProblem, type Cadence, type ScheduleTime } from '../lib/run-schedule-time';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { verifyTableOwnership } from '../lib/sheet-crud-helpers';
import { MAX_COLUMN_RUN_COLUMNS } from '../lib/constants-setups';
import { currentActor } from '../lib/actor';
import { runColumnOf } from './run-controls-column';
import type { RunFail } from './run-shared';

export const SCHEDULE_ROWS = ['empty', 'errored', 'out_of_date', 'all'] as const;
export type ScheduleRows = typeof SCHEDULE_ROWS[number];

export interface ScheduleRow {
  id: string; user_id: string; sheet_id: string | null; table_id: string | null; columns: string | null;
  rows: ScheduleRows; cadence: Cadence; at_time: string | null; time_zone: string; weekday: number | null;
  month_day: number | null; every_hours: number | null; max_cost_usd: number | null; allow_unpriced: number;
  allow_secrets: number; paused: number; next_at: string; last_fired_at: string | null; last_run_ids: string | null;
  last_error: string | null; access_token_id: string | null; token_name: string | null; via: string;
  created_at: string; updated_at: string;
}
export interface ScheduleView {
  id: string; sheet_id: string | null; table_id: string | null; columns: string[] | null; rows: ScheduleRows;
  cadence: Cadence; at_time: string | null; time_zone: string; weekday: number | null; month_day: number | null;
  every_hours: number | null; max_cost_usd: number | null; allow_unpriced: boolean; paused: boolean;
  next_at: string; last_fired_at: string | null; last_run_ids: string[]; last_error: string | null;
  made_by: string; created_at: string; updated_at: string;
}

// SQLite "YYYY-MM-DD HH:MM:SS" (UTC) and back.
export const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
export const msOf = (t: string) => Date.parse(`${t.replace(' ', 'T')}Z`);
const isoOf = (t: string | null) => (t ? new Date(msOf(t)).toISOString() : null);

export function scheduleView(r: ScheduleRow): ScheduleView {
  return {
    id: r.id, sheet_id: r.sheet_id, table_id: r.table_id, columns: r.columns ? JSON.parse(r.columns) as string[] : null,
    rows: r.rows, cadence: r.cadence, at_time: r.at_time, time_zone: r.time_zone, weekday: r.weekday,
    month_day: r.month_day, every_hours: r.every_hours, max_cost_usd: r.max_cost_usd,
    allow_unpriced: r.allow_unpriced === 1, paused: r.paused === 1, next_at: isoOf(r.next_at)!,
    last_fired_at: isoOf(r.last_fired_at), last_run_ids: r.last_run_ids ? JSON.parse(r.last_run_ids) as string[] : [],
    last_error: r.last_error, made_by: r.token_name ? `the access token "${r.token_name}"` : 'the app',
    created_at: isoOf(r.created_at)!, updated_at: isoOf(r.updated_at)!,
  };
}

// The fields a create or change may set (snake_case, as REST and MCP send them; the app sends the same).
export interface ScheduleFields {
  sheet_id?: unknown; table_id?: unknown; columns?: unknown; rows?: unknown; cadence?: unknown; at_time?: unknown;
  time_zone?: unknown; weekday?: unknown; month_day?: unknown; every_hours?: unknown; max_cost_usd?: unknown;
  allow_unpriced?: unknown;
}
const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const FIELDS = new Set(['sheet_id', 'table_id', 'columns', 'rows', 'cadence', 'at_time', 'time_zone', 'weekday',
  'month_day', 'every_hours', 'max_cost_usd', 'allow_unpriced']);
const numOrNull = (v: unknown) => (v === undefined || v === null ? null : v);

// A schedule's settings from what was sent over an existing one (null when creating), checked.
function settingsOf(f: ScheduleFields, was: ScheduleRow | null):
  Omit<ScheduleRow, 'id' | 'user_id' | 'sheet_id' | 'table_id' | 'paused' | 'next_at' | 'last_fired_at'
    | 'last_run_ids' | 'last_error' | 'access_token_id' | 'token_name' | 'via' | 'created_at' | 'updated_at'
    | 'allow_secrets'> | RunFail {
  // A misspelled field would be dropped without a word (a max_cost_usd typo: a firing with no ceiling).
  const stray = Object.keys(f).find(k => !FIELDS.has(k) && (f as Record<string, unknown>)[k] !== undefined);
  if (stray) return bad(`Unknown field ${stray}.`);
  const pick = <K extends keyof ScheduleFields>(k: K, old: unknown) => (f[k] === undefined ? old : f[k]);
  const columns = pick('columns', was?.columns ? JSON.parse(was.columns) : null);
  if (columns !== null && !(Array.isArray(columns) && columns.length >= 1 && columns.length <= MAX_COLUMN_RUN_COLUMNS
    && columns.every(c => typeof c === 'string' && c !== ''))) {
    return bad(`columns must be 1 to ${MAX_COLUMN_RUN_COLUMNS} column names, or null for every run column.`);
  }
  const rows = pick('rows', was?.rows);
  if (!SCHEDULE_ROWS.includes(rows as ScheduleRows)) return bad(`rows must be one of ${SCHEDULE_ROWS.join(', ')}.`);
  const cadence = pick('cadence', was?.cadence);
  if (!CADENCES.includes(cadence as Cadence)) return bad(`cadence must be one of ${CADENCES.join(', ')}.`);
  const time: ScheduleTime = {
    cadence: cadence as Cadence, atTime: numOrNull(pick('at_time', was?.at_time)) as string | null,
    timeZone: (pick('time_zone', was?.time_zone) ?? 'UTC') as string,
    weekday: numOrNull(pick('weekday', was?.weekday)) as number | null,
    monthDay: numOrNull(pick('month_day', was?.month_day)) as number | null,
    everyHours: numOrNull(pick('every_hours', was?.every_hours)) as number | null,
  };
  if (typeof time.timeZone !== 'string') return bad('time_zone must be an IANA name, such as Europe/Berlin.');
  const problem = scheduleTimeProblem(time);
  if (problem) return bad(problem);
  const max = numOrNull(pick('max_cost_usd', was?.max_cost_usd));
  if (max !== null && !(typeof max === 'number' && Number.isFinite(max) && max > 0)) {
    return bad('max_cost_usd must be more than $0, or null for none.');
  }
  const allow = pick('allow_unpriced', was ? was.allow_unpriced === 1 : false);
  if (typeof allow !== 'boolean') return bad('allow_unpriced must be true or false.');
  return {
    columns: columns === null ? null : JSON.stringify(columns), rows: rows as ScheduleRows, cadence: time.cadence,
    at_time: time.cadence === 'hours' ? null : time.atTime, time_zone: time.timeZone,
    weekday: time.cadence === 'weekly' ? time.weekday : null,
    month_day: time.cadence === 'monthly' ? time.monthDay : null,
    every_hours: time.cadence === 'hours' ? time.everyHours : null, max_cost_usd: max as number | null,
    allow_unpriced: allow ? 1 : 0,
  };
}

const timeOf = (s: Pick<ScheduleRow, 'cadence' | 'at_time' | 'time_zone' | 'weekday' | 'month_day' | 'every_hours'>):
  ScheduleTime => ({ cadence: s.cadence, atTime: s.at_time, timeZone: s.time_zone, weekday: s.weekday,
  monthDay: s.month_day, everyHours: s.every_hours });
export const nextAtOf = (s: Parameters<typeof timeOf>[0], after: number) => sqlTime(nextFireAt(timeOf(s), after));

// A sheet's schedule names run columns the sheet has, checked when they are set (a table's takes, on each sheet,
// the ones that sheet has). One deleted later is a firing's last_error.
function columnsProblem(userId: string, sheetId: string | null, columns: string | null): RunFail | null {
  if (!sheetId || !columns) return null;
  const gone = (JSON.parse(columns) as string[]).filter(c => !runColumnOf(sheetId, userId, c));
  if (!gone.length) return null;
  return bad(`${gone.map(c => `"${c}"`).join(', ')} ${gone.length === 1 ? 'isn\'t' : 'aren\'t'} an AI, HTTP API, `
    + 'enrichment or waterfall column of this sheet. Name its run columns, or leave columns out for all of them.');
}

// Who the schedule fires as from now: the caller (columns: run-schedule-fire.ts reads them).
function ownerNow(caller: { hasSecretsScope: boolean }) {
  const actor = currentActor();
  return { access_token_id: actor.tokenId, token_name: actor.tokenName,
    via: actor.via === 'cubex' ? 'app' : actor.via, allow_secrets: caller.hasSecretsScope ? 1 : 0 };
}

export const loadSchedule = (userId: string, id: string) =>
  db.prepare('SELECT * FROM run_schedules WHERE id = ? AND user_id = ?').get(id, userId) as ScheduleRow | undefined;

export function createSchedule(userId: string, f: ScheduleFields, caller: { hasSecretsScope: boolean }):
  { ok: ScheduleView } | RunFail {
  const sheetId = typeof f.sheet_id === 'string' && f.sheet_id ? f.sheet_id : null;
  const tableId = typeof f.table_id === 'string' && f.table_id ? f.table_id : null;
  if (!sheetId === !tableId) return bad('Pass sheet_id, or table_id for every sheet of a table.');
  if (sheetId && !verifySheetOwnership(sheetId, userId)) return { fail: 'not_found', message: 'Sheet not found' };
  if (tableId && !verifyTableOwnership(tableId, userId)) return { fail: 'not_found', message: 'Table not found' };
  const s = settingsOf(f, null);
  if ('fail' in s) return s;
  const gone = columnsProblem(userId, sheetId, s.columns);
  if (gone) return gone;
  const by = sheetId ? 'sheet_id' : 'table_id';
  const count = db.prepare(`SELECT COUNT(*) FROM run_schedules WHERE user_id = ? AND ${by} = ?`)
    .pluck().get(userId, sheetId ?? tableId) as number;
  if (count >= RUN_SCHEDULES_PER_TARGET) {
    return { fail: 'conflict', message: `A ${sheetId ? 'sheet' : 'table'} can have at most ${RUN_SCHEDULES_PER_TARGET} `
      + 'schedules. Delete one first.' };
  }
  const owner = ownerNow(caller);
  const id = uuidv4();
  db.prepare(`INSERT INTO run_schedules (id, user_id, sheet_id, table_id, columns, rows, cadence, at_time, time_zone,
      weekday, month_day, every_hours, max_cost_usd, allow_unpriced, allow_secrets, next_at, access_token_id,
      token_name, via) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, sheetId, tableId, s.columns,
    s.rows, s.cadence, s.at_time, s.time_zone, s.weekday, s.month_day, s.every_hours, s.max_cost_usd, s.allow_unpriced,
    owner.allow_secrets, nextAtOf(s, Date.now()), owner.access_token_id, owner.token_name, owner.via);
  return { ok: scheduleView(loadSchedule(userId, id)!) };
}

// A change: what was sent over what it has; its next firing worked out again from now when its time changed.
// It fires as the caller from then on.
export function changeSchedule(userId: string, id: string, f: ScheduleFields, caller: { hasSecretsScope: boolean })
  : { ok: ScheduleView } | RunFail {
  const was = loadSchedule(userId, id);
  if (!was) return { fail: 'not_found', message: 'Schedule not found' };
  if (f.sheet_id !== undefined || f.table_id !== undefined) return bad('A schedule\'s sheet or table can\'t change.');
  const s = settingsOf(f, was);
  if ('fail' in s) return s;
  const gone = f.columns === undefined ? null : columnsProblem(userId, was.sheet_id, s.columns);
  if (gone) return gone;
  const o = ownerNow(caller);
  const timeChanged = (['cadence', 'at_time', 'time_zone', 'weekday', 'month_day', 'every_hours'] as const)
    .some(k => s[k] !== was[k]);
  db.prepare(`UPDATE run_schedules SET columns = ?, rows = ?, cadence = ?, at_time = ?, time_zone = ?, weekday = ?,
      month_day = ?, every_hours = ?, max_cost_usd = ?, allow_unpriced = ?, next_at = ?, access_token_id = ?,
      token_name = ?, via = ?, allow_secrets = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?`).run(s.columns, s.rows, s.cadence, s.at_time, s.time_zone, s.weekday, s.month_day,
    s.every_hours, s.max_cost_usd, s.allow_unpriced, timeChanged ? nextAtOf(s, Date.now()) : was.next_at,
    o.access_token_id, o.token_name, o.via, o.allow_secrets, id, userId);
  return { ok: scheduleView(loadSchedule(userId, id)!) };
}

// Pause, or resume from now (a paused schedule doesn't fire at once for the time it was paused); resumed, it
// fires as the caller.
export function pauseSchedule(userId: string, id: string, paused: boolean, caller: { hasSecretsScope: boolean })
  : { ok: ScheduleView } | RunFail {
  const was = loadSchedule(userId, id);
  if (!was) return { fail: 'not_found', message: 'Schedule not found' };
  if (paused || was.paused === 0) {
    db.prepare(`UPDATE run_schedules SET paused = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
      .run(paused ? 1 : 0, id, userId);
  } else {
    const o = ownerNow(caller);
    db.prepare(`UPDATE run_schedules SET paused = 0, next_at = ?, access_token_id = ?, token_name = ?, via = ?,
        allow_secrets = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
      .run(nextAtOf(was, Date.now()), o.access_token_id, o.token_name, o.via, o.allow_secrets, id, userId);
  }
  return { ok: scheduleView(loadSchedule(userId, id)!) };
}

export function deleteSchedule(userId: string, id: string): { ok: { deleted: string } } | RunFail {
  const n = db.prepare('DELETE FROM run_schedules WHERE id = ? AND user_id = ?').run(id, userId).changes;
  return n ? { ok: { deleted: id } } : { fail: 'not_found', message: 'Schedule not found' };
}

// The user's schedules, or a sheet's (with its table's) or a table's, soonest first.
export function listSchedules(userId: string, by: { sheetId?: string; tableId?: string } = {}): ScheduleView[] {
  const rows = db.prepare(`SELECT * FROM run_schedules WHERE user_id = ?
      AND (? IS NULL OR sheet_id = ? OR table_id = (SELECT table_id FROM sheets WHERE id = ?))
      AND (? IS NULL OR table_id = ? OR sheet_id IN (SELECT id FROM sheets WHERE table_id = ?))
    ORDER BY paused, next_at`).all(userId, by.sheetId ?? null, by.sheetId ?? null, by.sheetId ?? null,
    by.tableId ?? null, by.tableId ?? null, by.tableId ?? null) as ScheduleRow[];
  return rows.map(scheduleView);
}
