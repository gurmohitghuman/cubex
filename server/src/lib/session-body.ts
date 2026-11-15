import express from 'express';
import { authenticateUser } from './auth';
import { SESSION_COOKIE_NAME } from './cookie';
import { hasBody } from './request-deadline';

// The app's own body parsers: JSON and forms up to 32 MB (autosave batches, bulk edits), for every path that
// doesn't parse its own (lib/server-middleware.ts). Every route they serve checks the session cookie first
// (middleware/auth.ts), so they read a body only when that cookie is a valid session. Without one the body is
// left unread and the route answers 401: a client with no account can't make the server hold or parse anything.
// A request without a body goes through them as before (they only set req.body to {}).
// The app never compresses what it sends, so a compressed body is refused (415) and never inflated. A body they
// can't take gets 413, 415 or 400 here, with no stack in the log.
const SESSION_BODY_LIMIT = '32mb';
const parsers = [
  express.json({ limit: SESSION_BODY_LIMIT, inflate: false }),
  express.urlencoded({ extended: true, limit: SESSION_BODY_LIMIT, inflate: false }),
];

function signedIn(req: express.Request): boolean {
  const token = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE_NAME];
  return typeof token === 'string' && authenticateUser(token) !== null;
}

// A parser's error as the answer the client gets. A body cut off (the client went away, or its deadline passed)
// has no one to answer.
function refuse(err: { type?: string; status?: number }, res: express.Response): void {
  if (err.type === 'request.aborted') return;
  if (err.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body too large' });
  } else if (err.type === 'encoding.unsupported') {
    res.status(415).set('Accept-Encoding', 'identity').json({ error: 'Send the request body uncompressed' });
  } else if (err.type === 'charset.unsupported') {
    res.status(415).json({ error: 'Send the request body as UTF-8' });
  } else {
    const status = typeof err.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 400;
    res.status(status).json({ error: 'Invalid request body' });
  }
}

// Mounted once cookie-parser has run. `skip`: the paths whose routes parse their own bodies.
export function sessionBodyParsers(skip: (path: string) => boolean): express.RequestHandler {
  return (req, res, next) => {
    if (skip(req.path) || (hasBody(req) && !signedIn(req))) return next();
    let i = 0;
    const step = (err?: unknown): void => {
      if (err) return refuse(err as { type?: string; status?: number }, res);
      const parse = parsers[i++];
      if (!parse) return next();
      parse(req, res, step);
    };
    step();
  };
}
