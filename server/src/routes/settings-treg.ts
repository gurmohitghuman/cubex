// Settings → Enrichment: the treg key (save, test, clear) and the daily limit
// for all enrichments. Cookie session only (mounted under /api/settings), so an
// access token can never lift the limit the owner set.
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { checkTregKey } from '../lib/treg';
import { getTregToken, saveTregToken, clearTregToken, setDailyLimitMicro, dailyLimitView } from '../services/treg-key';
import { TREG_KEY_MAX_CHARS, ENRICH_DAILY_LIMIT_MIN_MICRO, ENRICH_DAILY_LIMIT_MAX_USD } from '../lib/constants';
import { clearKeyPauses } from '../services/autorun-entry';
import { noteTregReach } from '../services/treg-reach';

const router = express.Router();
router.use(authenticateToken);

// undefined: no key in the body; null: a key that can't be right (empty, spaces
// inside, too long), which is refused rather than quietly replaced.
function keyFromBody(body: unknown): string | null | undefined {
  const raw = (body as { apiKey?: unknown } | undefined)?.apiKey;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  return key && key.length <= TREG_KEY_MAX_CHARS && !/\s/.test(key) ? key : null;
}

const usd = (micro: number) => `$${(micro / 1e6).toFixed(2)}`;

router.put('/treg-key', (req: AuthRequest, res) => {
  try {
    const key = keyFromBody(req.body);
    if (!key) {
      return res.status(400).json({
        error: "That doesn't look like a treg API key. Paste the whole key, with no spaces.",
      });
    }
    saveTregToken(req.userId!, key);
    // Auto-runs stopped for the key (or the team's balance and rules) try again.
    clearKeyPauses(req.userId!);
    res.json({ message: 'treg key saved' });
  } catch (error) {
    console.error('Save treg key error:', error);
    res.status(500).json({ error: 'Failed to save the treg key' });
  }
});

// Tests the key in the body, or the saved one when the body has none.
router.post('/test-treg-key', async (req: AuthRequest, res) => {
  try {
    const typed = keyFromBody(req.body);
    if (typed === null) {
      return res.status(400).json({
        error: "That doesn't look like a treg API key. Paste the whole key, with no spaces.",
      });
    }
    const key = typed ?? getTregToken(req.userId!);
    if (!key) return res.status(400).json({ error: 'Paste your treg API key first.' });
    const result = await checkTregKey(key);
    noteTregReach(req.userId!, result.ok || result.problem !== 'unreachable');
    if (!result.ok) return res.json({ valid: false, problem: result.problem, message: result.message });
    const parts = ['Valid'];
    if (result.balanceMicro !== null) {
      parts.push(
        `Balance: ${usd(result.balanceMicro)}` +
        `${result.onHoldMicro ? ` (${usd(result.onHoldMicro)} on hold)` : ''}`,
      );
    }
    if (result.team) parts.push(`Team: ${result.team}`);
    res.json({
      valid: true,
      message: parts.join(' · '),
      team: result.team,
      balanceUsd: result.balanceMicro === null ? null : result.balanceMicro / 1e6,
      onHoldUsd: result.onHoldMicro === null ? null : result.onHoldMicro / 1e6,
    });
  } catch (error) {
    console.error('Test treg key error:', error);
    res.status(500).json({ error: 'Failed to test the treg key' });
  }
});

router.delete('/treg-key', (req: AuthRequest, res) => {
  try {
    clearTregToken(req.userId!);
    res.json({ message: 'treg key cleared' });
  } catch (error) {
    console.error('Clear treg key error:', error);
    res.status(500).json({ error: 'Failed to clear the treg key' });
  }
});

router.get('/enrich-daily-limit', (req: AuthRequest, res) => {
  res.json(dailyLimitView(req.userId!));
});

// { limitUsd: number } sets it; { limitUsd: null } turns it off.
router.put('/enrich-daily-limit', (req: AuthRequest, res) => {
  try {
    const { limitUsd } = (req.body ?? {}) as { limitUsd?: unknown };
    if (limitUsd === null) {
      setDailyLimitMicro(req.userId!, null);
      return res.json(dailyLimitView(req.userId!));
    }
    if (
      typeof limitUsd !== 'number' || !Number.isFinite(limitUsd) ||
      limitUsd <= 0 || limitUsd > ENRICH_DAILY_LIMIT_MAX_USD
    ) {
      return res.status(400).json({
        error: `The daily limit must be between $0.01 and $${ENRICH_DAILY_LIMIT_MAX_USD.toLocaleString()}, or off.`,
      });
    }
    setDailyLimitMicro(req.userId!, Math.max(ENRICH_DAILY_LIMIT_MIN_MICRO, Math.round(limitUsd * 1e6)));
    res.json(dailyLimitView(req.userId!));
  } catch (error) {
    console.error('Set enrichment daily limit error:', error);
    res.status(500).json({ error: 'Failed to save the daily limit' });
  }
});

export default router;
