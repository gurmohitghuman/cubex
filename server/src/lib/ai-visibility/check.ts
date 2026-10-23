// Checking an AI visibility table again (services/ai-visibility-check.ts), the
// pure part: the day the answers kept were asked, how old they are, and the
// names the check gives the dated sheets and the two new columns.
import { MAX_SHEET_NAME_LENGTH } from '../constants';

// "2026-10-01" from a SQLite datetime ("2026-10-01 14:03:22", UTC).
export const dayOf = (sqliteTime: string): string => sqliteTime.slice(0, 10);

// A time zone the asker gave ("Europe/Berlin"), or null for one Intl doesn't know.
export function timeZoneOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: raw }); return raw; } catch { return null; }
}

// The day of a SQLite datetime (UTC) where the asker is: an evening ask in
// New York is that evening's date, not tomorrow's. No time zone: the UTC day.
export function dayIn(sqliteTime: string, timeZone: string | null): string {
  if (!timeZone) return dayOf(sqliteTime);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(`${sqliteTime.replace(' ', 'T')}Z`));
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// Whole days from `sqliteTime` (UTC) to `now`.
export function daysSince(sqliteTime: string, now = Date.now()): number {
  const then = Date.parse(`${sqliteTime.replace(' ', 'T')}Z`);
  return Number.isFinite(then) ? Math.max(0, Math.floor((now - then) / 86_400_000)) : 0;
}

// What a check says when the answers it keeps are under three weeks old.
export const soonNote = (days: number): string => `${days === 0 ? 'These answers are from today.'
  : `These answers are ${days} day${days === 1 ? '' : 's'} old.`} AI answers change slowly and vary from one ask `
  + 'to the next, so checking again within three weeks mostly shows that variation.';

// `base` (cut to fit `max`), or "<base> 2", "<base> 3"… when taken.
export function freeName(base: string, taken: (name: string) => boolean, max = MAX_SHEET_NAME_LENGTH): string {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : ` ${n}`;
    let chars = Array.from(base);
    while (chars.join('').length > max - suffix.length) chars = chars.slice(0, -1);
    const name = `${chars.join('').trimEnd()}${suffix}`;
    if (!taken(name)) return name;
  }
}

export interface CheckNames { questionsCopy: string; sitesCopy: string | null; namedBy: string; change: string }

// The dated sheets ("Questions 2026-10-01", after the sheets' own names) and
// the columns ("Named by on 2026-10-01", "Change since 2026-10-01"), each free.
export function checkNames(
  label: string, sheets: { questions: string; sites: string | null },
  sheetTaken: (name: string) => boolean, columnTaken: (name: string) => boolean,
): CheckNames {
  // Each date fits after the name: the name gives way, never the date.
  const dated = (name: string) =>
    `${Array.from(name).slice(0, MAX_SHEET_NAME_LENGTH - 20).join('').trimEnd()} ${label}`;
  const questionsCopy = freeName(dated(sheets.questions), sheetTaken);
  const sitesCopy = sheets.sites === null ? null
    : freeName(dated(sheets.sites), n => sheetTaken(n) || n.toLowerCase() === questionsCopy.toLowerCase());
  const namedBy = freeName(`Named by on ${label}`, columnTaken);
  const change = freeName(`Change since ${label}`, n => columnTaken(n) || n.toLowerCase() === namedBy.toLowerCase());
  return { questionsCopy, sitesCopy, namedBy, change };
}
