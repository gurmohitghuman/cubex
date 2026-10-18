// Dates in cells and conditions (pure): the calendar day a text names, as a
// day number (days since 1970-01-01), or null when it names none. The date
// operators (ops.ts) compare these, in SQL as cubex_date (sql-functions.ts)
// and in "Only run if" rules, so every reader agrees on what is a date.
//
// Read, ignoring case and outer spaces:
//   2024-01-31, 2024/01/31, 2024.01.31        year first: always year, month, day
//   1/31/2024, 31/1/2024, 1-31-2024           year last: month first, unless the first number is over 12
//   31.1.2024                                 dots with the year last: day first (European)
//   Jan 31, 2024, January 31st 2024           month names in English, short or full
//   31 Jan 2024, 31-Jan-2024, Wed, 31 Jan 2024
// each optionally followed by a time ("T10:30:00Z", " 10:30 PM", " 10:30:00 GMT+0100").
// The day is the one written: the time and its zone are read and left out.
// Years have four digits; a bare number ("20240131", "1706659200") is no date.
const MAX_DATE_CHARS = 64;

// A Map, not an object: "constructor" must not read as a month.
const MONTHS = new Map<string, number>(Object.entries({
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
}));

// A time after the date (groups: hour, minute, second, a or p), its zone included.
const TIME = String.raw`(?:(?:t|\s+|,\s*)(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d{1,9})?)?(?:\s*([ap])\.?m\.?)?`
  + String.raw`(?:\s*(?:z|utc|gmt))?(?:\s*[+-]\d{2}(?::?\d{2})?)?)?`;
const WEEKDAY = String.raw`(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\.?,?\s+)?`;
const ORDINAL = '(?:st|nd|rd|th)?';
const YEAR_FIRST = new RegExp(String.raw`^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})${TIME}$`);
const YEAR_LAST = new RegExp(String.raw`^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})${TIME}$`);
const MONTH_FIRST = new RegExp(String.raw`^${WEEKDAY}([a-z]+)\.?\s+(\d{1,2})${ORDINAL},?\s+(\d{4})${TIME}$`);
const DAY_FIRST = new RegExp(String.raw`^${WEEKDAY}(\d{1,2})${ORDINAL}[\s-]+([a-z]+)\.?,?[\s-]+(\d{4})${TIME}$`);

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const DAYS_IN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// Days since 1970-01-01 in the proleptic Gregorian calendar (H. Hinnant's
// days_from_civil), with no Date object, so no time zone can shift a day.
function dayNumber(y: number, m: number, d: number): number | null {
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > (m === 2 && isLeap(y) ? 29 : DAYS_IN[m - 1])) return null;
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}

// The time groups (hour, minute, second, am/pm) hold a real time, or none.
function timeFits(h?: string, min?: string, s?: string, half?: string): boolean {
  if (h === undefined) return true;
  const hour = Number(h);
  if (half ? hour < 1 || hour > 12 : hour > 23) return false;
  return Number(min) <= 59 && (s === undefined || Number(s) <= 60);
}

export function asDate(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === 'object') return null;
  const trimmed = String(v).trim();
  if (trimmed.length < 8 || trimmed.length > MAX_DATE_CHARS) return null;
  const t = trimmed.toLowerCase();
  let m: RegExpExecArray | null;
  if (t[0] >= '0' && t[0] <= '9') {
    if ((m = YEAR_FIRST.exec(t))) {
      return timeFits(m[5], m[6], m[7], m[8]) ? dayNumber(+m[1], +m[3], +m[4]) : null;
    }
    if ((m = YEAR_LAST.exec(t))) {
      if (!timeFits(m[5], m[6], m[7], m[8])) return null;
      const a = +m[1], b = +m[3];
      const dayFirst = m[2] === '.' || a > 12;
      return dayFirst ? dayNumber(+m[4], b, a) : dayNumber(+m[4], a, b);
    }
    return dayFirst(t);
  }
  if ((m = MONTH_FIRST.exec(t))) {
    const month = MONTHS.get(m[1]);
    return month && timeFits(m[4], m[5], m[6], m[7]) ? dayNumber(+m[3], month, +m[2]) : null;
  }
  return dayFirst(t);
}

// 31 Jan 2024, Wed, 31 Jan 2024 10:00 GMT.
function dayFirst(t: string): number | null {
  const m = DAY_FIRST.exec(t);
  const month = m ? MONTHS.get(m[2]) : undefined;
  return m && month && timeFits(m[4], m[5], m[6], m[7]) ? dayNumber(+m[3], month, +m[1]) : null;
}
