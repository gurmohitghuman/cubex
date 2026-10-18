// What a usage read asks for (pure), the same on every surface (the app,
// /api/v1/usage, MCP get_usage): how rows are grouped, how many, and the date
// range: this week, this month, last week, last month or two days picked, as
// whole UTC days (the daily limit's days), both ends included. Weeks start on Monday.
import { USAGE_DEFAULT_ROWS, USAGE_MAX_RANGE_DAYS, USAGE_MAX_ROWS } from './constants';

export const USAGE_GROUPS = ['column', 'day', 'run'] as const;
export type UsageGroupBy = typeof USAGE_GROUPS[number];

export const USAGE_RANGES = ['this_week', 'this_month', 'last_week', 'last_month', 'custom'] as const;
export type UsageRangeName = typeof USAGE_RANGES[number];
export interface UsageRange { range: UsageRangeName; from: string; to: string }

const DAY = 86_400_000;
const day = (d: Date) => d.toISOString().slice(0, 10);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function namedRange(name: Exclude<UsageRangeName, 'custom'>, now: Date): UsageRange {
  const today = utcMidnight(now);
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY);
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  if (name === 'this_week') return { range: name, from: day(monday), to: day(today) };
  if (name === 'last_week') {
    const start = new Date(monday.getTime() - 7 * DAY);
    return { range: name, from: day(start), to: day(new Date(monday.getTime() - DAY)) };
  }
  if (name === 'this_month') return { range: name, from: day(first), to: day(today) };
  const lastFirst = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  return { range: name, from: day(lastFirst), to: day(new Date(first.getTime() - DAY)) };
}

// A real calendar day ("2026-02-30" isn't one).
const validDay = (s: string) => DAY_RE.test(s) && day(new Date(`${s}T00:00:00Z`)) === s;

// { range } or { from, to } (a custom range); nothing: this month.
export function parseUsageRange(
  input: { range?: unknown; from?: unknown; to?: unknown }, now: Date,
): { ok: UsageRange } | { error: string } {
  const { range, from, to } = input;
  if (from !== undefined || to !== undefined || range === 'custom') {
    if (range !== undefined && range !== 'custom') return { error: 'Pass a range or from and to, not both.' };
    if (typeof from !== 'string' || typeof to !== 'string' || !validDay(from) || !validDay(to)) {
      return { error: 'from and to must be days like 2026-10-01.' };
    }
    if (from > to) return { error: 'from must be on or before to.' };
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY + 1;
    if (span > USAGE_MAX_RANGE_DAYS) return { error: `A range can cover at most ${USAGE_MAX_RANGE_DAYS} days.` };
    return { ok: { range: 'custom', from, to } };
  }
  if (range === undefined) return { ok: namedRange('this_month', now) };
  if (typeof range !== 'string' || !(USAGE_RANGES as readonly string[]).includes(range)) {
    return { error: `range must be one of ${USAGE_RANGES.join(', ')}.` };
  }
  return { ok: namedRange(range as Exclude<UsageRangeName, 'custom'>, now) };
}

// The range as started_at bounds: from its first second to the next day's.
export function rangeBounds(r: UsageRange): { start: string; end: string } {
  const next = day(new Date(Date.parse(`${r.to}T00:00:00Z`) + DAY));
  return { start: `${r.from} 00:00:00`, end: `${next} 00:00:00` };
}

export interface UsageQuery { groupBy: UsageGroupBy; range: UsageRange; limit: number }

// group_by (default column), limit (default USAGE_DEFAULT_ROWS) and the range.
export function parseUsageQuery(
  input: { group_by?: unknown; limit?: unknown; range?: unknown; from?: unknown; to?: unknown }, now: Date,
): { ok: UsageQuery } | { error: string } {
  const groupBy = input.group_by ?? 'column';
  if (typeof groupBy !== 'string' || !(USAGE_GROUPS as readonly string[]).includes(groupBy)) {
    return { error: `group_by must be one of ${USAGE_GROUPS.join(', ')}.` };
  }
  const limit = input.limit === undefined ? USAGE_DEFAULT_ROWS : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > USAGE_MAX_ROWS) {
    return { error: `limit must be a whole number from 1 to ${USAGE_MAX_ROWS}.` };
  }
  const range = parseUsageRange(input, now);
  if ('error' in range) return range;
  return { ok: { groupBy: groupBy as UsageGroupBy, range: range.ok, limit } };
}
