import type { Request, Response } from 'express';

// Centralized cookie name + options so the set/clear/read paths can't drift.
// SameSite=Strict eliminates CSRF for our same-origin SPA without needing a
// CSRF token middleware. HttpOnly stops JS reads.
//
// Secure is set when the request itself arrived over HTTPS: directly
// (req.secure) or through a TLS-terminating reverse proxy that sets
// X-Forwarded-Proto. A plain-HTTP install (http://192.168.1.10:3002) gets a
// non-Secure cookie, because browsers silently drop Secure cookies on http://
// and the login would never stick. Trusting the header is safe: a spoofed value
// can only mark a cookie Secure on a connection that then can't store it.
//
// Max-Age matches the JWT's 30d expiry (lib/auth.ts) so they expire together.

export const SESSION_COOKIE_NAME = 'cubex_session';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function isHttps(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.get('x-forwarded-proto');
  return typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https';
}

function cookieOptions(req: Request) {
  return {
    httpOnly: true,
    secure: isHttps(req),
    sameSite: 'strict' as const,
    path: '/',
  };
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, { ...cookieOptions(req), maxAge: COOKIE_MAX_AGE_MS });
}

export function clearSessionCookie(req: Request, res: Response): void {
  // Pass the same options that were used to set the cookie. Browsers compare
  // Path + Domain when deleting; mismatched attributes leave a stale cookie
  // around that the user keeps sending.
  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions(req));
}
