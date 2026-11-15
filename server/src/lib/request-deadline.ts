import type express from 'express';
import type { IncomingMessage } from 'node:http';
import { MAX_CSV_UPLOAD_BYTES } from './constants';
import { HTTP_HEADERS_TIMEOUT_MS } from './constants-server';
import { envInt } from './env-int';

// A deadline on receiving each request, for the whole app (index.ts mounts it before anything reads a body). Any
// request has REQUEST_BODY_TIMEOUT_MS from its headers to send its body. A CSV upload gets longer, by its size,
// once its route knows who is sending it (allowUpload). Node's own requestTimeout can't tell routes apart, so it
// is only the backstop, past the longest deadline here (receiveBackstopMs, lib/server-timeouts.ts).
//
// Past the deadline the request gets 408, on the socket, not through res: the route still reading gets nothing
// more of the body and sees its request closed with the connection, and what it sends later goes nowhere. If the
// route already answered (before reading the body), the connection is just closed. Only receiving is timed: once
// the request is all in, the answer can take as long as it needs (run progress streams).

// 2 minutes: the largest JSON body the app takes (32 MB) at about 2 Mbit/s.
export const REQUEST_BODY_TIMEOUT_MS = envInt('REQUEST_BODY_TIMEOUT_MS', 120_000);
// A CSV upload gets one more second per this many bytes of its size: 128 KB/s, a 500 MB file at 1 Mbit/s.
export const UPLOAD_MIN_BYTES_PER_SECOND = envInt('UPLOAD_MIN_KB_PER_SECOND', 128) * 1024;

// The time a CSV upload of this many bytes gets, from its headers (the size capped at the upload limit).
export const uploadDeadlineMs = (bytes: number): number =>
  REQUEST_BODY_TIMEOUT_MS + Math.ceil((Math.min(bytes, MAX_CSV_UPLOAD_BYTES) / UPLOAD_MIN_BYTES_PER_SECOND) * 1000);

// Node's requestTimeout, counted from a request's first byte: the headers' deadline, the largest upload's, and a
// minute to spare.
export const receiveBackstopMs = (): number =>
  HTTP_HEADERS_TIMEOUT_MS + uploadDeadlineMs(MAX_CSV_UPLOAD_BYTES) + 60_000;

const TIMED_OUT = 'HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';
// How long a connection that got its 408 waits for the client to close its side: time to read the 408 on a slow
// link and stop sending.
const CLOSE_GRACE_MS = 5_000;
// The time left until a deadline, at most setTimeout's longest wait (about 24.8 days; longer would fire at once).
export const waitMs = (started: number, ms: number): number =>
  Math.min(2_147_483_647, Math.max(0, started + ms - Date.now()));
type Deadline = { started: number; res: express.Response; timer: NodeJS.Timeout };
const deadlines = new WeakMap<IncomingMessage, Deadline>();

function arm(req: express.Request, res: express.Response, started: number, ms: number): void {
  const old = deadlines.get(req);
  if (old) clearTimeout(old.timer);
  const timer = setTimeout(() => cutOff(req, res), waitMs(started, ms));
  deadlines.set(req, { started, res, timer });
}

function clear(req: IncomingMessage): void {
  const deadline = deadlines.get(req);
  if (deadline) clearTimeout(deadline.timer);
  deadlines.delete(req);
}

function cutOff(req: express.Request, res: express.Response): void {
  deadlines.delete(req);
  const socket = req.socket;
  if (req.complete || socket.destroyed) return;
  // Only while this request's answer owns the socket: a request pipelined behind another one's answer has none
  // yet, and the 408 would land inside that answer.
  if (res.headersSent || res.socket !== socket || !socket.writable) {
    socket.destroy();
    return;
  }
  // The 408 goes out first, then the connection ends. Closing it at once, with the body still arriving, resets
  // it, and a client on Windows drops what it hadn't read yet when reset, the 408 with it. So until the client
  // closes its side, or the grace runs out, what it still sends is read and dropped, never passed on to the request.
  // Replacing the socket's 'data' listeners takes it back from Node's request parser, as Node does for an upgrade.
  socket.removeAllListeners('data');
  socket.on('data', () => {});
  socket.resume();
  socket.end(TIMED_OUT);
  const grace = setTimeout(() => socket.destroy(), CLOSE_GRACE_MS);
  socket.once('close', () => clearTimeout(grace));
}

// Without Transfer-Encoding, and with no Content-Length or one of 0, there is no body: the request was all in with
// its headers.
export function hasBody(req: IncomingMessage): boolean {
  const length = req.headers['content-length'];
  return req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
}

export function requestDeadline(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!hasBody(req)) return next();
  arm(req, res, Date.now(), REQUEST_BODY_TIMEOUT_MS);
  req.once('end', () => clear(req));
  req.once('close', () => clear(req));
  next();
}

// A CSV upload's route calls this once it knows who is sending (a signed-in user, an access token or a working
// upload link), before it reads the body: the deadline, still counted from the headers, becomes the upload's for
// its declared size. A body sent without a size counts as the largest.
export function allowUpload(req: express.Request): void {
  const deadline = deadlines.get(req);
  if (!deadline) return;
  const declared = Number(req.headers['content-length']);
  const bytes = Number.isFinite(declared) && declared >= 0 ? declared : MAX_CSV_UPLOAD_BYTES;
  arm(req, deadline.res, deadline.started, uploadDeadlineMs(bytes));
}
