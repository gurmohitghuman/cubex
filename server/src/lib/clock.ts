// The clock enrichments count days by (UTC): the daily limit, an auto-run's
// daily cap and the day an auto-run started. End-to-end tests move it to the
// next day: CUBEX_TEST_CLOCK_FILE (set only by scripts/e2e-harness.mjs, never in
// production) names a file holding an offset in milliseconds, added to the real
// time. It is re-read at most every half second, so the API process and the
// run workers (each with its own copy of this module) agree on the time.
import fs from 'node:fs';

const FILE = process.env.CUBEX_TEST_CLOCK_FILE || '';
const READ_EVERY_MS = 500;
let offset = 0;
let readAt = 0;

function offsetMs(): number {
  if (!FILE) return 0;
  const now = Date.now();
  if (now - readAt >= READ_EVERY_MS) {
    readAt = now;
    try {
      const n = Number(fs.readFileSync(FILE, 'utf8').trim());
      offset = Number.isFinite(n) ? n : 0;
    } catch { offset = 0; }
  }
  return offset;
}

export function nowDate(): Date {
  return new Date(Date.now() + offsetMs());
}

export function utcDay(now: Date = nowDate()): string {
  return now.toISOString().slice(0, 10);
}
