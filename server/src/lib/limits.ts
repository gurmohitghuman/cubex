import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { LOGIN_RATE_WINDOW_MS, LOGIN_RATE_MAX } from './constants';
import { API_V1_RATE_PER_MIN } from './api-v1-constants';
import type { DeviceRequest } from './device-cookie';

// Neither limiter is keyed on IP address: Cubex is self-hosted with a single
// account, so client IPs carry no useful identity (and behind a reverse proxy
// they're all the proxy's). The X-Forwarded-For validation is off for the same
// reason — we never read it, so its presence behind a proxy isn't a misconfig.
const COMMON = {
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
} as const;

const TOO_MANY = { error: 'Too many attempts. Try again in a few minutes.' };

// Failed login / setup / change-password attempts from browsers that never
// signed in: ONE budget for the whole instance. There is a single account, so
// a shared budget protects it from password guessing however many addresses an
// attacker uses, and with the device budgets below it bounds the 64 MiB argon2
// hashes a window can bring (argon2 runs at most 4 at once on Node's thread
// pool). Successful attempts don't count, and a real owner signs in rarely
// (sessions last 30 days). A browser that has signed in before spends
// deviceLoginLimiter's instead (routes/auth.ts).
export const loginLimiter = rateLimit({
  ...COMMON,
  windowMs: LOGIN_RATE_WINDOW_MS,
  max: LOGIN_RATE_MAX,
  keyGenerator: () => 'instance',
  skipSuccessfulRequests: true,
  message: TOO_MANY,
});

// The same budget for each browser holding a device cookie (lib/device-cookie.ts),
// so wrong guesses from elsewhere, which spend the shared one, can't lock the
// owner out of it. Keyed on the device id the route validated BEFORE this runs,
// never on an unchecked cookie: only a sign-in can mint a key.
export const deviceLoginLimiter = rateLimit({
  ...COMMON,
  windowMs: LOGIN_RATE_WINDOW_MS,
  max: LOGIN_RATE_MAX,
  keyGenerator: (req: DeviceRequest) => `device:${req.deviceId}`,
  skipSuccessfulRequests: true,
  message: TOO_MANY,
});

// /api/v1 + /mcp — keyed on the ACCESS TOKEN id, which authenticateAccessToken
// sets BEFORE this runs (never key a bucket on an unvalidated credential), so a
// runaway script or agent throttles its own token rather than every integration.
export const apiV1Limiter = rateLimit({
  ...COMMON,
  windowMs: 60 * 1000,
  max: API_V1_RATE_PER_MIN,
  keyGenerator: (req: Request & { accessTokenId?: string }) => req.accessTokenId ?? 'unauthenticated',
  message: { error: 'Rate limit exceeded for this access token. Please try again in a minute.' },
});
