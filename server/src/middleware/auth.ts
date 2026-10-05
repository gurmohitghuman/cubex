import { Request, Response, NextFunction } from 'express';
import { authenticateUser } from '../lib/auth';
import { SESSION_COOKIE_NAME } from '../lib/cookie';

export interface AuthRequest extends Request {
  userId?: string;
}

// Extract the session JWT exclusively from the HttpOnly cookie. There is no
// Authorization-header fallback: it would bypass the SameSite=Strict CSRF
// protection (a token leaked via XSS/log/extension could be replayed from
// another origin via fetch+Authorization). Programmatic access uses personal
// access tokens on /api/v1 and /mcp instead (middleware/access-token-auth.ts).
function extractToken(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, string | undefined> }).cookies;
  return cookies?.[SESSION_COOKIE_NAME] ?? null;
}

export const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  const userId = authenticateUser(token);
  if (!userId) {
    // 401, not 403: an invalid / expired / revoked (logout or password change)
    // token means UNAUTHENTICATED. The client's axios interceptor redirects to
    // /login on 401, so this restores the auto-bounce.
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.userId = userId;
  next();
};
