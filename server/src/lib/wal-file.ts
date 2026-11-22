// The WAL file made its full size before the server serves (index.ts, after migrations, before any other thread
// or process opens the database), on Windows; tests switch it. There a commit that has to grow the -wal file can
// wait on the OS with nothing to do on the CPU: on the Windows CI runner, hiring-summarize-big's first pass had
// commits of 50 to 66 ms off the CPU in 5 of 40 passes with the file growing, and none in 40 passes with it already
// this size; within the whole unit suite one took 233 ms. Linux showed no such wait either way.
// The size is journal_size_limit (lib/db.ts): SQLite only ever cuts the file down to it, when it starts the WAL
// over, and a clean close deletes the file, so once per start is enough. Zeros past SQLite's last frame are never
// read as frames: SQLite rejects a frame whose page number is 0, and takes a WAL header of zeros (no magic number)
// for an empty WAL.
// It runs in a write transaction (BEGIN IMMEDIATE): no connection can add frames, start the WAL over or cut the
// file meanwhile, and it writes only past the file's end, so it never touches a frame. Skipped (logged) unless the
// disk has the room and WAL_FILE_FREE_MARGIN; a write that fails part way is cut back to the size the file had.
// Its own handle is on the -wal file only: SQLite keeps no lock on that file (its locks are on the database and the
// -shm file), so closing this handle can't drop one of SQLite's POSIX locks. Never open the database or the -shm
// file this way. On Windows Node opens a file sharing read, write and delete, as SQLite's own handles do, never
// exclusively; the handle is closed before this answers.
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import type { Database } from 'better-sqlite3';
import { WAL_FILE_FREE_MARGIN } from './constants';

const CHUNK = 1024 * 1024;

let on = process.platform === 'win32';
export const walFileSizing = (): boolean => on;
// Tests only: on or off; null, the platform's own.
export function setWalFileSizingForTests(v: boolean | null): void { on = v ?? process.platform === 'win32'; }

export type WalFileSized =
  | { done: 'sized'; from: number; to: number; ms: number }
  | { done: 'skipped'; why: 'off' | 'no limit' | 'no file' | 'big enough' }
  | { done: 'skipped'; why: 'low disk'; free: number | null; needed: number }
  | { done: 'failed'; error: string; from: number };

// The file system calls that can fail or vary, swappable in tests (a nearly full disk, a write failing part way).
export interface WalFileIo {
  freeBytes(dir: string): number | null;
  write(fd: number, zeros: Buffer, length: number, at: number): number;
}
const realIo: WalFileIo = {
  freeBytes(dir) {
    try {
      const s = fs.statfsSync(dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch { return null; }
  },
  write: (fd, zeros, length, at) => fs.writeSync(fd, zeros, 0, length, at),
};

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

export function sizeWalFile(conn: Database, dbPath: string, io: WalFileIo = realIo): WalFileSized {
  if (!on) return { done: 'skipped', why: 'off' };
  const limit = Number(conn.pragma('journal_size_limit', { simple: true }));
  if (!(limit > 0)) return { done: 'skipped', why: 'no limit' };
  const r = conn.transaction(() => grow(`${dbPath}-wal`, limit, io)).immediate();
  if (r.done === 'failed') {
    console.error(`The WAL file couldn't be made ${mb(limit)} at start (${r.error}); it grows as it's written.`);
  } else if (r.done === 'skipped' && r.why === 'low disk') {
    console.error(`The WAL file wasn't made ${mb(limit)} at start: the disk has ${r.free === null ? 'an unknown amount'
      : mb(r.free)} free, under ${mb(r.needed + WAL_FILE_FREE_MARGIN)}. It grows as it's written.`);
  }
  return r;
}

function grow(file: string, limit: number, io: WalFileIo): WalFileSized {
  let fd: number;
  try { fd = fs.openSync(file, 'r+'); } catch { return { done: 'skipped', why: 'no file' }; }
  try {
    const from = fs.fstatSync(fd).size;
    if (from >= limit) return { done: 'skipped', why: 'big enough' };
    const needed = limit - from;
    const free = io.freeBytes(path.dirname(file));
    if (free === null || free < needed + WAL_FILE_FREE_MARGIN) {
      return { done: 'skipped', why: 'low disk', free, needed };
    }
    const t0 = performance.now();
    const zeros = Buffer.alloc(CHUNK);
    try {
      for (let at = from; at < limit;) {
        const wrote = io.write(fd, zeros, Math.min(CHUNK, limit - at), at);
        if (!(wrote > 0)) throw new Error(`a write at ${at} wrote nothing`);
        at += wrote;
      }
      fs.fsyncSync(fd);
    } catch (err) {
      try { fs.ftruncateSync(fd, from); } catch { /* the error answered says what failed */ }
      return { done: 'failed', error: (err as Error).message, from };
    }
    return { done: 'sized', from, to: limit, ms: performance.now() - t0 };
  } finally {
    fs.closeSync(fd);
  }
}
