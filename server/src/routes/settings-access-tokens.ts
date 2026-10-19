// Personal-access-token management — session-cookie-authenticated (this is a
// UI surface; tokens themselves cannot mint/revoke tokens, so a leaked PAT
// can't escalate). The full token is returned exactly once, from POST. Each
// token's spend cap is set here too, and only here (services/token-spend.ts).
import express from 'express';
import crypto from 'node:crypto';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { generateAccessToken, validateScopes } from '../lib/access-token';
import {
  ACCESS_TOKEN_NAME_PATTERN,
  MAX_ACCESS_TOKENS_PER_USER,
  MAX_ACCESS_TOKEN_EXPIRY_DAYS,
} from '../lib/constants';
import { parseSpendCap, spendView, type SpendView } from '../lib/token-spend';
import { setTokenSpendCap, tokenSpendViews } from '../services/token-spend';

const router = express.Router();
router.use(authenticateToken);

const LIST_COLUMNS =
  'id, name, token_prefix, scopes, expires_at, created_at, last_used_at';

// Each token with its spend: cap, spent and left (lib/token-spend.ts).
const withSpend = (rows: Array<{ id: string }>, views: Map<string, SpendView>) =>
  rows.map(r => ({ ...r, spend: views.get(r.id) ?? spendView(null, 0) }));

router.get('/access-tokens', (req: AuthRequest, res) => {
  try {
    const rows = db.prepare(
      `SELECT ${LIST_COLUMNS} FROM access_tokens
       WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
    ).all(req.userId!) as Array<{ id: string }>;
    res.json(withSpend(rows, tokenSpendViews(req.userId!)));
  } catch (error) {
    console.error('List access tokens error:', error);
    res.status(500).json({ error: 'Failed to fetch access tokens' });
  }
});

router.post('/access-tokens', (req: AuthRequest, res) => {
  try {
    const { name, scopes, expires_in_days, spend_cap_usd } = req.body as {
      name?: unknown; scopes?: unknown; expires_in_days?: unknown; spend_cap_usd?: unknown;
    };
    if (typeof name !== 'string' || !ACCESS_TOKEN_NAME_PATTERN.test(name.trim())) {
      return res.status(400).json({
        error: 'Token name is required: 1-60 letters, numbers, spaces, underscores, or hyphens',
      });
    }
    const trimmedName = name.trim();
    const v = validateScopes(scopes);
    if (typeof v === 'string') return res.status(400).json({ error: v });

    let expiryDays: number | null = null;
    if (expires_in_days !== undefined && expires_in_days !== null) {
      if (!Number.isInteger(expires_in_days) || (expires_in_days as number) < 1
        || (expires_in_days as number) > MAX_ACCESS_TOKEN_EXPIRY_DAYS) {
        return res.status(400).json({
          error: `expires_in_days must be an integer between 1 and ${MAX_ACCESS_TOKEN_EXPIRY_DAYS}`,
        });
      }
      expiryDays = expires_in_days as number;
    }
    const cap = parseSpendCap(spend_cap_usd);
    if ('error' in cap) return res.status(400).json({ error: cap.error });

    const generated = generateAccessToken();
    const id = crypto.randomUUID();
    // Cap check + name check + insert in one IMMEDIATE transaction so the cap
    // can't be exceeded even if a future edit introduces an await into this
    // span (today the sync span alone would suffice — see limits.ts on the
    // run-concurrency check — but the txn survives refactors).
    const created = db.transaction(() => {
      const activeCount = (db.prepare(
        'SELECT COUNT(*) AS n FROM access_tokens WHERE user_id = ? AND revoked_at IS NULL',
      ).get(req.userId!) as { n: number }).n;
      if (activeCount >= MAX_ACCESS_TOKENS_PER_USER) return 'cap' as const;

      const nameClash = db.prepare(
        'SELECT id FROM access_tokens WHERE user_id = ? AND LOWER(name) = LOWER(?) AND revoked_at IS NULL',
      ).get(req.userId!, trimmedName);
      if (nameClash) return 'name' as const;

      // datetime('now', '+' || NULL || ' days') is NULL, so one statement covers
      // both the expiring and never-expiring cases. expiryDays is a validated int.
      db.prepare(`
        INSERT INTO access_tokens (id, user_id, name, token_hash, token_prefix, scopes, expires_at, spend_cap_micro)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' days'), ?)
      `).run(id, req.userId!, trimmedName, generated.tokenHash, generated.tokenPrefix, v.scopes, expiryDays,
        cap.micro);
      return 'ok' as const;
    }).immediate();
    if (created === 'cap') {
      return res.status(400).json({
        error: `Maximum of ${MAX_ACCESS_TOKENS_PER_USER} active access tokens reached. Revoke one first.`,
      });
    }
    if (created === 'name') {
      return res.status(409).json({ error: 'An access token with this name already exists' });
    }

    const row = db.prepare(`SELECT ${LIST_COLUMNS} FROM access_tokens WHERE id = ?`).get(id) as { id: string };
    // token: shown ONCE. Not stored, not logged, never retrievable again.
    res.status(201).json({ ...withSpend([row], tokenSpendViews(req.userId!))[0], token: generated.token });
  } catch (error) {
    // The partial UNIQUE index backstops the name check against races.
    if ((error as { code?: string }).code?.startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'An access token with this name already exists' });
    }
    console.error('Create access token error:', error);
    res.status(500).json({ error: 'Failed to create access token' });
  }
});

// The token's lifetime spend cap: { spend_cap_usd: dollars, or null for none }.
// Raising it lets the token's runs paused at the cap be resumed (its auto-runs
// go on by themselves); lowering it below what was spent pauses them.
router.patch('/access-tokens/:id', (req: AuthRequest, res) => {
  try {
    const body = req.body as { spend_cap_usd?: unknown } | undefined;
    if (!body || !('spend_cap_usd' in body)) {
      return res.status(400).json({ error: 'spend_cap_usd is required (a dollar amount, or null for no cap)' });
    }
    const cap = parseSpendCap(body.spend_cap_usd);
    if ('error' in cap) return res.status(400).json({ error: cap.error });
    const spend = setTokenSpendCap(req.userId!, req.params.id, cap.micro);
    if (!spend) return res.status(404).json({ error: 'Access token not found' });
    res.json({ spend });
  } catch (error) {
    console.error('Set access token spend cap error:', error);
    res.status(500).json({ error: 'Failed to set the spend cap' });
  }
});

router.delete('/access-tokens/:id', (req: AuthRequest, res) => {
  try {
    const result = db.prepare(
      `UPDATE access_tokens SET revoked_at = datetime('now')
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    ).run(req.params.id, req.userId!);
    if (result.changes === 0) return res.status(404).json({ error: 'Access token not found' });
    res.json({ message: 'Access token revoked' });
  } catch (error) {
    console.error('Revoke access token error:', error);
    res.status(500).json({ error: 'Failed to revoke access token' });
  }
});

export default router;
