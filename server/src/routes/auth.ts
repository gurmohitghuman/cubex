import express from 'express';
import { db } from '../lib/db';
import { createAccount } from '../services/account';
import { signToken, authenticateUser } from '../lib/auth';
import { hashPassword, verifyPassword, needsRehash, newPasswordError } from '../lib/password';
import { setSessionCookie, clearSessionCookie, SESSION_COOKIE_NAME } from '../lib/cookie';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { loginLimiter } from '../lib/limits';
import { MAX_PASSWORD_LENGTH } from '../lib/constants';

// Single-user auth. Cubex has exactly one account: whoever opens a fresh install
// first chooses the password (POST /setup), unless INITIAL_PASSWORD created the
// account at boot (services/account.ts). From then on that password is the only
// way in. There is no email and no reset link; a forgotten password is reset on
// the server with `npm run reset-password` (server/src/cli).
const router = express.Router();

// JSON bodies ONLY (the global parsers skip /api/auth — server-middleware.ts).
// An HTML form on another site can post urlencoded or multipart data to
// http://localhost:3002/api/auth/setup without any CORS check, so accepting
// those would let any page you visit claim a fresh install. A cross-site JSON
// POST needs a preflight, which fails without CORS headers. The tiny limit also
// keeps unauthenticated callers from making us parse megabytes.
router.use(express.json({ limit: '4kb' }));
router.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!err) return next();
  return res.status(err.type === 'entity.too.large' ? 413 : 400).json({ error: 'Invalid request body' });
});

// Defense in depth for the same attack: browsers label every request with
// Sec-Fetch-Site, and Cubex's own pages are always 'same-origin' (in dev Vite
// proxies /api). Anything else is another site submitting to these routes.
// Non-browser clients (curl, scripts) don't send the header.
router.use((req, res, next) => {
  const site = req.get('sec-fetch-site');
  if (req.method === 'POST' && site && site !== 'same-origin' && site !== 'none') {
    return res.status(403).json({ error: 'Cross-site request refused' });
  }
  next();
});

// Body fields, or {} when the body wasn't JSON (express.json leaves it unset).
const body = (req: express.Request) => (req.body ?? {}) as Record<string, unknown>;

interface UserRow { id: string; password_hash: string; session_epoch: number }

const getUser = (): UserRow | undefined =>
  db.prepare('SELECT id, password_hash, session_epoch FROM users LIMIT 1').get() as UserRow | undefined;

const ALREADY_SET_UP = 'Cubex is already set up. Sign in with your password.';

function sessionUserId(req: express.Request): string | null {
  const token = (req as express.Request & { cookies?: Record<string, string | undefined> })
    .cookies?.[SESSION_COOKIE_NAME];
  return token ? authenticateUser(token) : null;
}

// Re-read the epoch at signing time: an await sits between the caller's read and
// here, and a concurrent logout may have bumped it. A token signed with a stale
// epoch would be rejected on its very next request.
function startSession(req: express.Request, res: express.Response, userId: string): void {
  const row = db.prepare('SELECT session_epoch FROM users WHERE id = ?')
    .get(userId) as { session_epoch: number } | undefined;
  setSessionCookie(req, res, signToken({ userId, sessionEpoch: row?.session_epoch ?? 0 }));
}

// Public. Tells the login page which form to show.
router.get('/status', (req, res) => {
  res.json({ setupRequired: !getUser(), authenticated: sessionUserId(req) !== null });
});

// Public, but only until an account exists. The already-set-up check runs
// BEFORE the limiter, so poking /setup on a live instance can't burn the shared
// sign-in budget. Hash first (slow, async), then createAccount checks and
// inserts in ONE synchronous transaction, so two racing setup requests can't
// both create an account.
const refuseIfSetUp = (_req: express.Request, res: express.Response, next: express.NextFunction) =>
  getUser() ? res.status(409).json({ error: ALREADY_SET_UP }) : next();

router.post('/setup', refuseIfSetUp, loginLimiter, async (req, res) => {
  const { password } = body(req);
  const invalid = newPasswordError(password);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const id = createAccount(await hashPassword(password as string));
    if (!id) return res.status(409).json({ error: ALREADY_SET_UP });
    startSession(req, res, id);
    res.json({ ok: true });
  } catch (error) {
    console.error('Setup error:', error);
    res.status(500).json({ error: 'Failed to set the password' });
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  const { password } = body(req);
  // Cap the length BEFORE argon2 so a huge body can't tie up a hash.
  if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LENGTH) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  try {
    const user = getUser();
    if (!user) return res.status(409).json({ error: 'No password has been set yet.', setupRequired: true });
    if (!(await verifyPassword(password, user.password_hash))) {
      return res.status(401).json({ error: 'Wrong password' });
    }
    // Transparent rehash when the hashing parameters changed. Best-effort: the
    // existing hash verified, so a failure here must not fail the login.
    if (needsRehash(user.password_hash)) {
      try {
        db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
          .run(await hashPassword(password), user.id);
      } catch (err) {
        console.error('Password rehash failed (login still succeeded):', err);
      }
    }
    startSession(req, res, user.id);
    res.json({ ok: true });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to sign in' });
  }
});

// Clears the cookie AND bumps session_epoch, so the token is revoked centrally
// (a copied cookie can't outlive logout). The epoch is per-user, so this signs
// out every browser. A missing/expired cookie still gets a clean logout.
router.post('/logout', (req, res) => {
  const userId = sessionUserId(req);
  try {
    if (userId) {
      db.prepare("UPDATE users SET session_epoch = session_epoch + 1, updated_at = datetime('now') WHERE id = ?")
        .run(userId);
    }
  } catch (error) {
    // Revocation is best-effort: still clear the cookie, or a DB hiccup would
    // leave the browser signed in.
    console.error('Logout epoch bump failed (clearing cookie anyway):', error);
  } finally {
    clearSessionCookie(req, res);
  }
  res.json({ ok: true });
});

// Requires the current password, so a borrowed session can't lock the owner
// out. Bumps session_epoch: every other browser is signed out, and this one
// gets a fresh cookie. A wrong current password is a 400, not a 401: the
// client treats any 401 as "signed out" and would bounce to /login.
router.post('/change-password', authenticateToken, loginLimiter, async (req: AuthRequest, res) => {
  const { currentPassword, newPassword } = body(req);
  if (typeof currentPassword !== 'string' || currentPassword.length > MAX_PASSWORD_LENGTH) {
    return res.status(400).json({ error: 'Current password is wrong' });
  }
  const invalid = newPasswordError(newPassword);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?')
      .get(req.userId!) as { password_hash: string } | undefined;
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
      return res.status(400).json({ error: 'Current password is wrong' });
    }
    const hash = await hashPassword(newPassword as string);
    db.prepare("UPDATE users SET password_hash = ?, session_epoch = session_epoch + 1, updated_at = datetime('now') WHERE id = ?")
      .run(hash, req.userId!);
    startSession(req, res, req.userId!);
    res.json({ ok: true });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change the password' });
  }
});

export default router;
