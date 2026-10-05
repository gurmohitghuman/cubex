import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { encrypt, decrypt } from '../lib/crypto';
import { validateKey, fetchAccountBalance, fetchModels } from '../lib/openrouter';

const router = express.Router();
router.use(authenticateToken);

// Settings index. Doesn't return the raw key — just a boolean indicator.
router.get('/', (req: AuthRequest, res) => {
  try {
    const settings = db.prepare(
      'SELECT id, openrouter_api_key_encrypted, default_ai_model, created_at, updated_at FROM settings WHERE user_id = ?',
    ).get(req.userId!) as
      | { id: string; openrouter_api_key_encrypted: string | null; default_ai_model: string | null; created_at: string; updated_at: string }
      | undefined;

    res.json({
      id: settings?.id || null,
      // "Saved" means usable: a key encrypted under a since-replaced encryption
      // key no longer decrypts, and runs treat it as missing, so say so here too
      // and the user re-enters it.
      hasOpenRouterKey: !!settings?.openrouter_api_key_encrypted
        && decrypt(settings.openrouter_api_key_encrypted) !== null,
      defaultAiModel: settings?.default_ai_model || null,
      created_at: settings?.created_at || null,
      updated_at: settings?.updated_at || null,
    });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

router.put('/openrouter-key', (req: AuthRequest, res) => {
  try {
    const { apiKey } = req.body as { apiKey?: unknown };
    if (typeof apiKey !== 'string' || !apiKey.trim()) return res.status(400).json({ error: 'API key is required' });

    const ciphertext = encrypt(apiKey.trim());
    const existing = db.prepare('SELECT id FROM settings WHERE user_id = ?').get(req.userId!) as { id: string } | undefined;

    if (existing) {
      db.prepare(
        "UPDATE settings SET openrouter_api_key_encrypted = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
      ).run(ciphertext, existing.id, req.userId!);
    } else {
      db.prepare('INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?, ?, ?)')
        .run(uuidv4(), req.userId!, ciphertext);
    }
    res.json({ message: 'OpenRouter API key updated successfully' });
  } catch (error) {
    console.error('Update OpenRouter key error:', error);
    res.status(500).json({ error: 'Failed to update OpenRouter API key' });
  }
});

router.post('/test-openrouter-key', async (req: AuthRequest, res) => {
  try {
    const { apiKey } = req.body as { apiKey?: unknown };
    if (typeof apiKey !== 'string' || !apiKey.trim()) return res.status(400).json({ error: 'API key is required' });
    const key = apiKey.trim();

    try {
      const result = await validateKey(key);
      if (!result.ok) {
        return res.json({
          valid: false,
          message: result.status === 401 ? 'Invalid API key' : `Failed to validate (${result.status})`,
        });
      }
      const data = result.data;

      // /auth/key reports only this KEY's lifetime usage + its optional per-key
      // spend cap — NOT the account balance. We additionally hit the account-level
      // /credits endpoint for real remaining balance; it may 403 for non-
      // provisioning keys, so on failure we fall back to the usage-only view.
      const balance = await fetchAccountBalance(key);

      // Normalize the key fields. usage stays null when /auth/key omits it (don't
      // fabricate a $0 "spent" figure), limit is number | null (never undefined —
      // the client distinguishes "no limit" with === null). /auth/key always
      // returns usage in practice, but a missing/non-number value must neither
      // crash the client's .toFixed() nor display a false dollar amount.
      const usage = data && typeof data.usage === 'number' ? data.usage : null;
      const limit = data && typeof data.limit === 'number' ? data.limit : null;
      // Per-key limit text. With trusted usage we can show "$X remaining of $Y";
      // without it, only state the cap ("$Y key limit") — never imply how much
      // is left. null when no per-key limit is set.
      const keyLimitPart = limit === null
        ? null
        : usage !== null
          ? `$${Math.max(0, limit - usage).toFixed(2)} remaining of $${limit.toFixed(2)} key limit`
          : `$${limit.toFixed(2)} key limit`;

      let creditMessage = 'API key is valid';
      if (balance !== null) {
        creditMessage = keyLimitPart
          ? `Valid · $${balance.toFixed(2)} balance · ${keyLimitPart}`
          : `Valid · $${balance.toFixed(2)} balance`;
      } else if (usage !== null) {
        creditMessage = keyLimitPart ? `Valid · ${keyLimitPart}` : `Valid · $${usage.toFixed(2)} used on this key`;
      } else if (keyLimitPart) {
        creditMessage = `Valid · ${keyLimitPart}`;
      }

      // Emit credits only when there's something numeric to show — balance, a
      // trustworthy key usage figure, or a key limit. usage is omitted (not 0)
      // when untrusted so the client won't print a fabricated "Spent" amount.
      res.json({
        valid: true,
        message: creditMessage,
        credits: (balance !== null || usage !== null || limit !== null)
          ? {
              usage: usage ?? undefined,
              limit,
              isFreeTier: data?.is_free_tier,
              balance: balance ?? undefined,
            }
          : undefined,
      });
    } catch (error: any) {
      console.error('OpenRouter validation request failed:', error);
      const aborted = error?.name === 'AbortError';
      res.json({
        valid: false,
        message: aborted ? 'Validation timed out — OpenRouter may be slow. Try again.' : 'Failed to validate API key',
      });
    }
  } catch (error) {
    console.error('Test OpenRouter key error:', error);
    res.status(500).json({ error: 'Failed to test API key' });
  }
});

router.delete('/openrouter-key', (req: AuthRequest, res) => {
  try {
    const settings = db.prepare('SELECT id FROM settings WHERE user_id = ?').get(req.userId!) as { id: string } | undefined;
    if (!settings) return res.status(404).json({ error: 'Settings not found' });

    db.prepare(
      "UPDATE settings SET openrouter_api_key_encrypted = NULL, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
    ).run(settings.id, req.userId!);

    res.json({ message: 'OpenRouter API key cleared successfully' });
  } catch (error) {
    console.error('Clear OpenRouter key error:', error);
    res.status(500).json({ error: 'Failed to clear OpenRouter API key' });
  }
});

router.get('/openrouter-models', async (_req: AuthRequest, res) => {
  try {
    const result = await fetchModels(Date.now());
    if (result.ok) return res.json(result.models);

    // Upstream failed — serve stale cache if we have it, else a clean 502.
    if (result.stale) return res.json(result.stale);
    const msg = result.aborted
      ? 'OpenRouter took too long to respond.'
      : result.status
        ? `Failed to fetch models from OpenRouter (${result.status})`
        : 'Failed to reach OpenRouter.';
    res.status(502).json({ error: msg });
  } catch (error) {
    console.error('List OpenRouter models error:', error);
    res.status(500).json({ error: 'Failed to fetch OpenRouter models' });
  }
});

export default router;
