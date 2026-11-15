import type { NextFunction, Request, Response } from 'express';
import type { Socket } from 'node:net';
import { envInt } from './env-int';

// A deadline on an answer its client stopped reading, for the whole app (index.ts mounts it before anything
// answers). Only answer data waiting to go out is timed: while some of the answer is still in Node's buffers, it
// must keep moving out to the system, and if none moves for RESPONSE_STALL_TIMEOUT_MS, the answer and its
// connection are closed. Any byte moving counts, but bytes are seen moving only as the system takes them into its
// network buffers, which can hold MBs, so a very slow reader can still be cut. Measured on Linux at the default:
// below about 20 to 40 KB/s over TCP on the same machine (a proxy in front), 2.5 to 5 KB/s on a Unix socket
// (docs/configuration.md).
// Nothing is timed while an answer is silent: a run's progress stream between events, the long-poll before it
// answers, a handler still working out its answer. Closing an answer fires its 'close', which ends a CSV export
// waiting on a client that stopped reading (lib/csv-write.ts), and with it the export's hold on its sheet.
// It wraps res.write and res.end, and looks again when an answer queued behind another one on its connection gets
// its socket, so everything that writes an answer goes through it: res.json and res.send, files sent by
// express.static and res.sendFile (piped into res.write), event streams, the MCP transport and the JSON escaping
// wrapper (lib/json-c1-escape.ts) under it. A small answer to a client that never reads fits the system's buffers:
// it finishes at once, and the server's keep-alive timeout closes the idle connection.

// 60 s: rides out a phone switching networks or a short dead zone, and is what proxies commonly allow between
// two writes to a client, so behind one nothing changes.
export const RESPONSE_STALL_TIMEOUT_MS = envInt('RESPONSE_STALL_TIMEOUT_MS', 60_000);
// At most setTimeout's longest wait (about 24.8 days; longer would fire at once).
const MAX_WAIT_MS = 2_147_483_647;
const STALL_WAIT_MS = Math.min(MAX_WAIT_MS, Math.max(1, RESPONSE_STALL_TIMEOUT_MS));
// Where the system shows no progress inside a write, the write in flight gets one more second per this many bytes
// of it before it counts as stalled: 16 KB/s, a 1 MB write one more minute. 0 or less counts as the default.
export const RESPONSE_MIN_BYTES_PER_SECOND = envInt('RESPONSE_MIN_KB_PER_SECOND', 16) * 1024;
// Unix systems take a write off libuv's queue bit by bit as it goes out; Windows only once all of it is out.
const PROGRESS_INSIDE_WRITES = process.platform !== 'win32';

// How far the socket has got handing its data to the system. `handed`: the bytes of its finished writes
// (bytesWritten also counts what still waits, so less that). `queued`: what is left of the write in progress,
// whose progress shows only in libuv's queue (one large write, as res.end of a big body, finishes only once all
// of it is out). Data moved out when more writes finished or less of the one in progress is left: new data
// queued behind it moves neither (a stream still writing to a client that reads nothing).
// `unseen`: the write in flight whose progress can't be seen, which gets time by its size. On Windows, libuv keeps
// a write in its queue whole until all of it is out, so the queue's size is that write. The queue's size is on
// Node's internal handle, not a public API; without it (no handle, or a Node that has none), `queued` stays 0, only
// finished writes count, and all the data waiting is unseen (the write in flight, and at most the buffer's mark
// behind it from a writer that waits for 'drain'). A handle gone mid-answer reads as data moved.
export type Progress = { handed: number; queued: number; unseen: number };
export function progressOf(socket: Socket): Progress {
  const size = (socket as Socket & { _handle?: { writeQueueSize?: unknown } | null })._handle?.writeQueueSize;
  const queued = typeof size === 'number' ? size : 0;
  const unseen = typeof size !== 'number' ? socket.writableLength : PROGRESS_INSIDE_WRITES ? 0 : queued;
  return { handed: socket.bytesWritten - socket.writableLength, queued, unseen };
}
export const moved = (now: Progress, seen: Progress) => now.handed > seen.handed || now.queued < seen.queued;

export function answerStall(_req: Request, res: Response, next: NextFunction): void {
  const write = res.write.bind(res) as (...a: unknown[]) => boolean;
  const end = res.end.bind(res) as (...a: unknown[]) => Response;
  let timer: NodeJS.Timeout | undefined;
  let socket: Socket | null = null;
  let seen: Progress = { handed: 0, queued: 0, unseen: 0 };
  let movedAt = 0;
  const stop = () => { clearTimeout(timer); timer = undefined; };
  // Nothing left to time: the answer is all out of Node's buffers, done, or no longer on this socket (keep-alive
  // hands the socket to the next request once this answer has finished).
  const idle = () => res.writableFinished || res.destroyed || !res.socket || res.writableLength === 0;
  const look = () => {
    timer = undefined;
    if (idle() || res.socket !== socket) return;
    const now = progressOf(socket!);
    if (moved(now, seen)) { seen = now; movedAt = performance.now(); timer = setTimeout(look, STALL_WAIT_MS); return; }
    // The time is fixed when data last moved: the write in flight then, not what piled up behind it since.
    const left = movedAt + STALL_WAIT_MS + (seen.unseen / RESPONSE_MIN_BYTES_PER_SECOND) * 1000 - performance.now();
    if (left > 0) { timer = setTimeout(look, Math.min(MAX_WAIT_MS, left)); return; }
    res.destroy();
  };
  const watch = () => {
    if (timer || idle()) return;
    socket = res.socket;
    seen = progressOf(socket!);
    movedAt = performance.now();
    timer = setTimeout(look, STALL_WAIT_MS);
    // res.write keeps its data in the socket until the next tick (it corks it), and only then is the write handed to
    // the system: what is left of it is read from there, or its progress would show only once all of it is out.
    process.nextTick(() => { if (res.socket === socket) seen = progressOf(socket!); });
  };
  res.write = ((...a: unknown[]) => { const r = write(...a); watch(); return r; }) as typeof res.write;
  res.end = ((...a: unknown[]) => { const r = end(...a); watch(); return r; }) as typeof res.end;
  // An answer pipelined behind another on its connection gets its socket only when that one is done, and Node then
  // writes what it had kept straight to the socket, not through res.write: look once that write is made.
  res.once('socket', () => process.nextTick(watch));
  res.on('drain', stop);
  res.once('finish', stop);
  res.once('close', stop);
  next();
}
