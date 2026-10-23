// Time-ordered ids for every new row (RFC 9562 UUIDv7: a millisecond
// timestamp, then random bits); a row back from the trash keeps its own.
// rows.id is a TEXT primary key: random UUIDv4s land each insert on a
// scattered page of its index, so a slice of 5,000 rows dirtied thousands of
// pages and its commit wrote about 20 MB of WAL (a million-row CSV import took
// 26 to 38 s and held the server up to 1.8 s; a sheet copy 43 s); ids that
// grow fill the index in order (8 to 9.5 s, under 0.35 s; docs/performance.md).
// They have the shape of any UUID, so whatever reads row ids takes them as is.
// (Node 22 has no crypto.randomUUIDv7.)
import { randomBytes } from 'node:crypto';

let lastMs = 0;
let seq = 0;
let pool = Buffer.alloc(0);
let at = 0;

// Increasing within the process: ids made in the same millisecond count up in
// the 12 bits after the version (rand_a, RFC 9562 6.2 method 1), and past 4,096
// the next millisecond is borrowed, so a clock set back never breaks the order.
export function orderedUuid(now = Date.now()): string {
  if (now > lastMs) { lastMs = now; seq = 0; }
  else if (++seq > 0xfff) { lastMs++; seq = 0; }
  if (at + 16 > pool.length) { pool = randomBytes(16 * 512); at = 0; }
  const b = pool.subarray(at, at + 16); // each 16 bytes of the pool serve one id
  at += 16;
  b.writeUIntBE(lastMs, 0, 6);
  b[6] = 0x70 | (seq >> 8);
  b[7] = seq & 0xff;
  b[8] = 0x80 | (b[8] & 0x3f);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
