// When a run schedule (services/run-schedule*.ts) fires next, pure: daily, on weekdays (Monday to Friday), weekly on
// a weekday, monthly on a day from 1 to 28, each at HH:MM in an IANA time zone, or every N hours from the last firing.
// A wall time a clock change skips (02:30 on a spring-forward night) fires at the first minute after it; one that
// happens twice (an autumn night) fires the first time. No library: the zone's offset comes from Intl.

export const CADENCES = ['daily', 'weekdays', 'weekly', 'monthly', 'hours'] as const;
export type Cadence = typeof CADENCES[number];
export interface ScheduleTime {
  cadence: Cadence; atTime: string | null; timeZone: string; weekday: number | null; monthDay: number | null;
  everyHours: number | null;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE = 60_000;
const DAY = 86_400_000;

export function validTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

// The zone's wall clock at an instant, as the UTC instant that reads the same (its offset folded in).
const formats = new Map<string, Intl.DateTimeFormat>();
function wallAsUtc(ms: number, zone: string): number {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric',
      day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formats.set(zone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}
const offsetAt = (ms: number, zone: string) => wallAsUtc(ms, zone) - Math.floor(ms / 1000) * 1000;

// The instant a wall time (given as the UTC instant that reads the same) happens in the zone: the earlier one when
// it happens twice, the first minute after it when a clock change skips it.
const exactly = (wall: number, zone: string): number | null => {
  for (const guess of [wall - offsetAt(wall - DAY / 2, zone), wall - offsetAt(wall + DAY / 2, zone)]) {
    if (wallAsUtc(guess, zone) === wall) return guess;
  }
  return null;
};
function instantOf(wall: number, zone: string): number {
  for (let m = 0; m <= 180; m++) {
    const t = exactly(wall + m * MINUTE, zone);
    if (t !== null) return t;
  }
  return wall - offsetAt(wall, zone);
}

// The problem with a schedule's time fields, or null.
export function scheduleTimeProblem(t: ScheduleTime): string | null {
  if (!CADENCES.includes(t.cadence)) return `cadence must be one of ${CADENCES.join(', ')}.`;
  if (!validTimeZone(t.timeZone)) return `"${t.timeZone}" isn't a time zone (an IANA name, such as Europe/Berlin).`;
  if (t.cadence === 'hours') {
    return Number.isInteger(t.everyHours) && t.everyHours! >= 1 && t.everyHours! <= 168 ? null
      : 'every_hours must be a whole number from 1 to 168.';
  }
  if (!t.atTime || !HHMM.test(t.atTime)) return 'at_time must be HH:MM (24-hour), such as 09:00.';
  if (t.cadence === 'weekly' && !(Number.isInteger(t.weekday) && t.weekday! >= 0 && t.weekday! <= 6)) {
    return 'weekday must be 0 (Sunday) to 6 (Saturday).';
  }
  if (t.cadence === 'monthly' && !(Number.isInteger(t.monthDay) && t.monthDay! >= 1 && t.monthDay! <= 28)) {
    return 'month_day must be from 1 to 28.';
  }
  return null;
}

// The first firing after `after` (ms). Every N hours goes on from `after` (the last firing, or when it was made).
export function nextFireAt(t: ScheduleTime, after: number): number {
  if (t.cadence === 'hours') return after + t.everyHours! * 3_600_000;
  const [, hh, mm] = HHMM.exec(t.atTime!)!;
  const today = new Date(wallAsUtc(after, t.timeZone));
  for (let i = 0; i <= 62; i++) {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + i));
    const dow = day.getUTCDay();
    if (t.cadence === 'weekdays' && (dow === 0 || dow === 6)) continue;
    if (t.cadence === 'weekly' && dow !== t.weekday) continue;
    if (t.cadence === 'monthly' && day.getUTCDate() !== t.monthDay) continue;
    const at = instantOf(day.getTime() + (Number(hh) * 60 + Number(mm)) * MINUTE, t.timeZone);
    if (at > after) return at;
  }
  throw new Error('No firing found in 62 days');
}
