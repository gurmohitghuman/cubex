// Every JSON answer writes U+0080-U+009F as \u0080-\u009f escapes: the app's
// /api, /api/v1, /mcp (JSON bodies and event streams), webhooks and the file
// links. Cells keep these characters (lib/csv-safety.ts), and an answer read
// in a terminal (curl prints it) then holds no raw C1 control. In JSON text
// they can only sit inside strings, so the escape parses to the same value.
// CSV downloads keep the raw bytes (they are written to a file).
//
// One middleware, first in the app, wraps the response's writeHead, write and
// end, so it covers res.json, res.send, the MCP adapter's chunked writes and
// event streams alike. It acts on a response whose Content-Type names JSON or
// an event stream; a byte chunk that ends in the first byte of such a
// character (C2) holds it back until the next chunk. A JSON body sent whole
// gets its Content-Length set again; a streamed one is sent without one.
import type { NextFunction, Request, Response } from 'express';

const ESCAPED_TYPE = /json|event-stream/i;
const C1 = /[\u0080-\u009F]/g;

const escapeOf = (code: number): string => `\\u00${code.toString(16)}`;
export const escapeC1 = (text: string): string => text.replace(C1, c => escapeOf(c.charCodeAt(0)));

// UTF-8 bytes with C2 80-C2 9F written as escapes. `held`: a C2 the chunk
// before ended in; `last`: no chunk follows, so nothing is held back.
export function escapeC1Bytes(chunk: Buffer, held: boolean, last: boolean): { out: Buffer; hold: boolean } {
  const buf = held ? Buffer.concat([Buffer.from([0xC2]), chunk]) : chunk;
  const hold = !last && buf.length > 0 && buf[buf.length - 1] === 0xC2;
  const end = hold ? buf.length - 1 : buf.length;
  const parts: Buffer[] = [];
  let from = 0;
  for (let i = buf.indexOf(0xC2); i !== -1 && i < end - 1; i = buf.indexOf(0xC2, i + 1)) {
    const next = buf[i + 1];
    if (next < 0x80 || next > 0x9F) continue;
    parts.push(buf.subarray(from, i), Buffer.from(escapeOf(next), 'latin1'));
    from = i + 2;
    i += 1;
  }
  if (from === 0 && end === buf.length) return { out: buf, hold };
  parts.push(buf.subarray(from, end));
  return { out: Buffer.concat(parts), hold };
}

const isUtf8 = (encoding: unknown) => encoding === undefined || /^utf-?8$/i.test(String(encoding));

// The Content-Type in writeHead's headers argument (an object, a flat
// [name, value, ...] list or a list of pairs), and that argument without its Content-Length.
function headersArg(arg: unknown): { type: string; rest: unknown } {
  if (Array.isArray(arg)) {
    const flat = arg.flat() as unknown[];
    let type = '';
    const rest: unknown[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const name = String(flat[i]).toLowerCase();
      if (name === 'content-type') type = String(flat[i + 1]);
      if (name !== 'content-length') rest.push(flat[i], flat[i + 1]);
    }
    return { type, rest };
  }
  if (!arg || typeof arg !== 'object') return { type: '', rest: arg };
  const rest: Record<string, unknown> = {};
  let type = '';
  for (const [name, value] of Object.entries(arg)) {
    if (name.toLowerCase() === 'content-type') type = String(value);
    if (name.toLowerCase() !== 'content-length') rest[name] = value;
  }
  return { type, rest };
}

export function escapeC1InJson(_req: Request, res: Response, next: NextFunction): void {
  const writeHead = res.writeHead.bind(res) as (...a: unknown[]) => Response;
  const write = res.write.bind(res) as (...a: unknown[]) => boolean;
  const end = res.end.bind(res) as (...a: unknown[]) => Response;
  let escaping: boolean | null = null;
  let held = false;
  const decide = (type?: string) => {
    escaping ??= ESCAPED_TYPE.test(type || String(res.getHeader('content-type') ?? ''));
    return escaping;
  };
  // The chunk to send instead, and the encoding to send it with.
  const convert = (chunk: unknown, encoding: unknown, last: boolean): [unknown, unknown] => {
    if (typeof chunk === 'string' && isUtf8(encoding) && !held) return [escapeC1(chunk), encoding];
    if (chunk === undefined || chunk === null || typeof chunk === 'function') {
      if (!held) return [chunk, encoding];
      held = false;
      return [Buffer.from([0xC2]), undefined];
    }
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding as BufferEncoding)
      : Buffer.from(chunk as Uint8Array);
    const { out, hold } = escapeC1Bytes(bytes, held, last);
    held = hold;
    return [out, undefined];
  };
  // write(chunk, [encoding], [callback]) and end([chunk], [encoding], [callback]).
  const split = (a: unknown[]): [unknown, unknown, unknown[]] => (typeof a[0] === 'function' ? [undefined, undefined, a]
    : typeof a[1] === 'function' ? [a[0], undefined, a.slice(1)] : [a[0], a[1], a.slice(2)]);

  // An explicit writeHead with headers starts a body sent in parts (the MCP
  // adapter, event streams): no Content-Length. Node's own call from end()
  // passes none, and leaves the length end() set.
  res.writeHead = ((...a: unknown[]) => {
    const at = a.findIndex((x, i) => i > 0 && x !== null && typeof x === 'object');
    if (at > 0) {
      const { type, rest } = headersArg(a[at]);
      if (decide(type)) {
        a[at] = rest;
        res.removeHeader('content-length');
      }
    }
    return writeHead(...a);
  }) as typeof res.writeHead;
  res.write = ((...a: unknown[]) => {
    if (!decide()) return write(...a);
    if (!res.headersSent) res.removeHeader('content-length');
    const [chunk, encoding, cb] = split(a);
    const [out, enc] = convert(chunk, encoding, false);
    return write(out, enc, ...cb);
  }) as typeof res.write;
  res.end = ((...a: unknown[]) => {
    if (!decide()) return end(...a);
    const [chunk, encoding, cb] = split(a);
    const [out, enc] = convert(chunk, encoding, true);
    if (!res.headersSent && res.getHeader('content-length') !== undefined && out !== undefined) {
      res.setHeader('content-length', Buffer.byteLength(out as string | Buffer, (enc ?? 'utf8') as BufferEncoding));
    }
    return out === undefined ? end(...cb) : end(out, enc, ...cb);
  }) as typeof res.end;
  next();
}
