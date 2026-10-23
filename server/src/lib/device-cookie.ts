import crypto from 'crypto';
import type { Request, Response } from 'express';
import { DEVICE_COOKIE_KEY } from './auth';
import { cookieOptions } from './cookie';
import { DEVICE_COOKIE_MAX_AGE_MS } from './constants';

// Device cookies, the OWASP defence against lockout through a shared sign-in
// limit. A browser that signs in gets cubex_device: a random device id and a
// MAC over it, the user and their password hash. Its failed sign-ins then
// count against a budget of its own (lib/limits.ts), so wrong guesses sent
// from anywhere else can't lock the owner out of a browser they've used.
//
// It lets nobody in (the password still does) and is sent only to /api/auth.
// Bound to the password hash, so changing or resetting the password ends every
// device cookie: one kept from a password someone once knew would otherwise go
// on giving them a budget of their own. A rehash of the same password ends
// them too; browsers still signed in get a new one on their next page load.

export const DEVICE_COOKIE_NAME = 'cubex_device';
const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;   // 16 random bytes, base64url

export interface DeviceUser { id: string; password_hash: string }
// A sign-in request whose device cookie checked out (routes/auth.ts), keyed on by deviceLoginLimiter.
export type DeviceRequest = Request & { deviceId?: string };

const macOf = (deviceId: string, user: DeviceUser): Buffer =>
  crypto.createHmac('sha256', DEVICE_COOKIE_KEY).update(`${deviceId}\n${user.id}\n${user.password_hash}`).digest();

// Every cubex_device the browser sent, read from the header: cookies aren't
// kept apart by port, so another app on the same host (or anyone on a plain
// HTTP network) can plant one with a longer path, which comes first and is the
// only one req.cookies keeps. The real one must still count.
function sentCookies(req: Request): string[] {
  const out: string[] = [];
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === DEVICE_COOKIE_NAME) out.push(part.slice(at + 1).trim());
  }
  return out;
}

export const sentDeviceCookie = (req: Request): boolean => sentCookies(req).length > 0;

// The device id of the first cookie that is this user's under their current password.
export function trustedDevice(req: Request, user: DeviceUser): string | null {
  for (const raw of sentCookies(req)) {
    const [deviceId, mac, extra] = raw.split('.');
    if (extra !== undefined || !DEVICE_ID.test(deviceId) || typeof mac !== 'string') continue;
    const got = Buffer.from(mac, 'base64url');
    const want = macOf(deviceId, user);
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return deviceId;
  }
  return null;
}

// A good cookie keeps its device id (and so its budget); anything else gets a new one.
export function setDeviceCookie(req: Request, res: Response, user: DeviceUser): void {
  const deviceId = trustedDevice(req, user) ?? crypto.randomBytes(16).toString('base64url');
  res.cookie(DEVICE_COOKIE_NAME, `${deviceId}.${macOf(deviceId, user).toString('base64url')}`, {
    ...cookieOptions(req), path: '/api/auth', maxAge: DEVICE_COOKIE_MAX_AGE_MS,
  });
}
