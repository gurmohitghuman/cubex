import jwt from 'jsonwebtoken';
import { db } from './db';
import { loadOrCreateInstanceSecret } from './instance-secret';

// ---- JWT ------------------------------------------------------------

// JWT_SECRET from the environment if set, otherwise a random secret generated
// on first boot and stored next to the database, so every install gets its own
// value and sessions survive restarts.
const JWT_SECRET = process.env.JWT_SECRET || loadOrCreateInstanceSecret('.jwt-secret');
// Matches the session cookie's Max-Age (lib/cookie.ts).
const JWT_EXPIRES_IN = '30d';

export interface TokenPayload {
  userId: string;
  // users.session_epoch at sign-in. Logout and password changes bump the epoch,
  // which revokes every token signed before them.
  sessionEpoch?: number;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
    algorithm: 'HS256',
  } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    // Pin the algorithm explicitly. The library rejects `alg: 'none'` by
    // default in 9.x, but the classic "alg confusion" attack (a token
    // signed as HS256 using the server's RS256 public key as the HMAC
    // secret) is mitigated by allow-listing the exact algorithm we issued
    // with above. Defense in depth.
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as unknown;
    // Be strict about the payload shape. Without these checks an attacker
    // who could forge tokens could send userId as a number, object, or
    // array and downstream SQL would behave unpredictably.
    if (!decoded || typeof decoded !== 'object') return null;
    const userId = (decoded as { userId?: unknown }).userId;
    if (typeof userId !== 'string' || userId.length === 0) return null;
    const rawEpoch = (decoded as { sessionEpoch?: unknown }).sessionEpoch;
    const sessionEpoch = typeof rawEpoch === 'number' && Number.isFinite(rawEpoch) ? rawEpoch : 0;
    return { userId, sessionEpoch };
  } catch {
    return null;
  }
}

// Full authentication: verify the JWT signature AND confirm its session epoch
// still matches the user's current epoch in the DB. Returns the userId or null.
//
// This is the single choke point for request auth — used by the auth middleware
// AND the two SSE routes that verify tokens by hand (EventSource can't send an
// Authorization header, so they read the cookie directly). Centralizing the
// epoch check here means a logout or password change revokes tokens everywhere,
// not just on routes that happen to go through the middleware.
//
// The epoch read is one indexed PK lookup per authenticated request — sub-ms on
// better-sqlite3. A token whose epoch is below the user's current epoch is
// rejected, and so is a token for a user that no longer exists.
export function authenticateUser(token: string): string | null {
  const payload = verifyToken(token);
  if (!payload) return null;
  const row = db.prepare('SELECT session_epoch FROM users WHERE id = ?')
    .get(payload.userId) as { session_epoch: number } | undefined;
  if (!row) return null;
  if ((payload.sessionEpoch ?? 0) < row.session_epoch) return null;
  return payload.userId;
}
