import type { NextFunction, Request, Response } from 'express';
import type { Socket } from 'node:net';
import { envInt } from './env-int';

// A deadline on an answer its client stopped reading, for the whole app (index.ts mounts it before anything
// answers). Only answer data waiting to go out is timed: while some of the answer is still in Node's buffers, it
// must keep moving out to the system, and if none moves for RESPONSE_STALL_TIMEOUT_MS, the answer and its
// connection are closed. Any byte moving counts, so a slow but steady client is never cut, however long it takes.
// Nothing is timed while an answer is silent: a run's progress stream between events, the long-poll before it
// answers, a handler still working out its answer. Closing an answer fires its 'close', which ends a CSV export
// waiting on a client that stopped reading (lib/csv-write.ts), and with it the export's hold on its sheet.
// It wraps res.write and res.end, so everything that writes an answer goes through it: res.json and res.send,
// files sent by express.static and res.sendFile (piped into res.write), event streams, the MCP transport and the
// JSON escaping wrapper (lib/json-c1-escape.ts) under it. A small answer to a client that never reads fits the
// system's buffers: it finishes at once, and the server's keep-alive timeout closes the idle connection.

// 60 s: rides out a phone switching networks or a short dead zone, and is what proxies commonly allow between
// two writes to a client, so behind one nothing changes.
export const RESPONSE_STALL_TIMEOUT_MS = envInt('RESPONSE_STALL_TIMEOUT_MS', 60_000);
// At most setTimeout's longest wait (about 24.8 days; longer would fire at once).
const STALL_WAIT_MS = Math.min(2_147_483_647, Math.max(1, RESPONSE_STALL_TIMEOUT_MS));

// How far the socket has got handing its data to the system. `handed`: the bytes of its finished writes
// (bytesWritten also counts what still waits, so less that). `queued`: what is left of the write in progress,
// whose progress shows only in libuv's queue (one large write, as res.end of a big body, finishes only once all
// of it is out). Data moved out when more writes finished or less of the one in progress is left: new data
// queued behind it moves neither (a stream still writing to a client that reads nothing).
// The queue's size is on Node's internal handle, not a public API. Without it (no handle, or a Node that has
// none), `queued` stays 0 and only finished writes count: a reader of one large write, slower than all of it in
// RESPONSE_STALL_TIMEOUT_MS, would then be cut. A handle gone mid-answer reads as data moved, never as a stall.
export type Progress = { handed: number; queued: number };
export function progressOf(socket: Socket): Progress {
  const queued = (socket as Socket & { _handle?: { writeQueueSize?: unknown } | null })._handle?.writeQueueSize;
  return { handed: socket.bytesWritten - socket.writableLength, queued: typeof queued === 'number' ? queued : 0 };
}
export const moved = (now: Progress, seen: Progress) => now.handed > seen.handed || now.queued < seen.queued;

export function answerStall(_req: Request, res: Response, next: NextFunction): void {
  const write = res.write.bind(res) as (...a: unknown[]) => boolean;
  const end = res.end.bind(res) as (...a: unknown[]) => Response;
  let timer: NodeJS.Timeout | undefined;
  let socket: Socket | null = null;
  let seen: Progress = { handed: 0, queued: 0 };
  const stop = () => { clearTimeout(timer); timer = undefined; };
  // Nothing left to time: the answer is all out of Node's buffers, done, or no longer on this socket (keep-alive
  // hands the socket to the next request once this answer has finished).
  const idle = () => res.writableFinished || res.destroyed || !res.socket || res.writableLength === 0;
  const look = () => {
    timer = undefined;
    if (idle() || res.socket !== socket) return;
    const now = progressOf(socket!);
    if (moved(now, seen)) { seen = now; timer = setTimeout(look, STALL_WAIT_MS); return; }
    res.destroy();
  };
  const watch = () => {
    if (timer || idle()) return;
    socket = res.socket;
    seen = progressOf(socket!);
    timer = setTimeout(look, STALL_WAIT_MS);
  };
  res.write = ((...a: unknown[]) => { const r = write(...a); watch(); return r; }) as typeof res.write;
  res.end = ((...a: unknown[]) => { const r = end(...a); watch(); return r; }) as typeof res.end;
  res.on('drain', stop);
  res.once('finish', stop);
  res.once('close', stop);
  next();
}
