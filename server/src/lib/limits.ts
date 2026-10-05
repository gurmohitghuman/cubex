import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { LOGIN_RATE_WINDOW_MS, LOGIN_RATE_MAX } from './constants';
import { API_V1_RATE_PER_MIN } from './api-v1-constants';

// Neither limiter is keyed on IP address: Cubex is self-hosted with a single
// account, so client IPs carry no useful identity (and behind a reverse proxy
// they're all the proxy's). The X-Forwarded-For validation is off for the same
// reason — we never read it, so its presence behind a proxy isn't a misconfig.
const COMMON = {
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
} as const;

// Failed login / setup / change-password attempts: ONE budget for the whole
// instance. There is a single account, so a shared budget protects it from
// password guessing however many addresses an attacker uses, and it bounds how
// many 64 MiB argon2 hashes can run at once. Successful attempts don't count,
// and a real owner signs in rarely (sessions last 30 days).
export const loginLimiter = rateLimit({
  ...COMMON,
  windowMs: LOGIN_RATE_WINDOW_MS,
  max: LOGIN_RATE_MAX,
  keyGenerator: () => 'instance',
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts. Try again in a few minutes.' },
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
