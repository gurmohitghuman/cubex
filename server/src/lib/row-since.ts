// read_rows' and REST rows/query's `updated_since` (pure): the time asked for,
// read as UTC whole seconds the way rows.updated_at holds them (SQLite's
// datetime('now'): 2026-11-05 10:00:00), the times answered (ISO 8601 UTC:
// 2026-11-05T10:00:00Z), and the opaque cursor of a walk (services/rows-since.ts).

const SQL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
// ISO 8601 with seconds and a zone: 2026-11-05T10:00:00Z, 2026-11-05T11:00:00.250+01:00.
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const SQL_PARTS = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

export const SINCE_FORMAT_HELP = 'updated_since must be a UTC time such as 2026-11-05T10:00:00Z (ISO 8601 with '
  + 'seconds and a zone) or 2026-11-05 10:00:00 (as SQLite writes it, UTC).';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function sqlOf(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// The UTC instant of y-m-d h:m:s, or null when a part is out of range (no 2026-02-30, no 24:00:00).
function utcMs(parts: string[]): number | null {
  const [y, mo, d, h, mi, s] = parts.map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (y < 1 || back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d
    || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== s) return null;
  return ms;
}

// The time as rows.updated_at compares it, or an error. A fraction of a second
// is dropped (the read starts at that whole second, so it only adds rows).
export function parseSinceTime(raw: unknown): { sql: string } | { error: string } {
  if (typeof raw !== 'string') return { error: SINCE_FORMAT_HELP };
  const t = raw.trim();
  const sql = SQL_PARTS.exec(t);
  if (sql) {
    const ms = utcMs(sql.slice(1, 7));
    return ms === null ? { error: SINCE_FORMAT_HELP } : { sql: sqlOf(ms) };
  }
  const iso = ISO_TIME.exec(t);
  if (!iso) return { error: SINCE_FORMAT_HELP };
  const ms = utcMs(iso.slice(1, 7));
  const zone = iso[8];
  if (ms === null) return { error: SINCE_FORMAT_HELP };
  if (zone === 'Z') return { sql: sqlOf(ms) };
  const [zh, zm] = zone.slice(1).split(':').map(Number);
  if (zh > 23 || zm > 59) return { error: SINCE_FORMAT_HELP };
  const offset = (zone[0] === '-' ? -1 : 1) * (zh * 60 + zm) * 60_000;
  return { sql: sqlOf(ms - offset) };
}

// rows.updated_at (or any SQLite time) as ISO 8601 UTC; anything else as it is.
export const isoTime = (sql: string): string => (SQL_TIME.test(sql) ? `${sql.replace(' ', 'T')}Z` : sql);

// Where a walk is: the row last answered (its updated_at and rowid), and what
// its first page fixed: the updated_since asked, the newest time it reads
// (`until`, so a walk ends even while rows keep changing) and the as_of it answers.
export interface SinceCursor { since: string; t: string; r: number; until: string; asOf: string }

export function encodeSinceCursor(c: SinceCursor): string {
  return Buffer.from(JSON.stringify([1, c.since, c.t, c.r, c.until, c.asOf]), 'utf8').toString('base64url');
}

export function decodeSinceCursor(raw: string): SinceCursor | null {
  let parts: unknown;
  try { parts = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { return null; }
  if (!Array.isArray(parts) || parts.length !== 6 || parts[0] !== 1) return null;
  const [, since, t, r, until, asOf] = parts as unknown[];
  const times = [since, t, until, asOf];
  if (!times.every(v => typeof v === 'string' && SQL_TIME.test(v))) return null;
  if (typeof r !== 'number' || !Number.isSafeInteger(r) || r < 0) return null;
  return { since: since as string, t: t as string, r, until: until as string, asOf: asOf as string };
}
