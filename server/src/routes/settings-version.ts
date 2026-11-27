// Settings → Account → Version: the running version, the latest release and whether the daily check
// is on (services/version-info.ts). Cookie session only (mounted under /api/settings); GET /v1/version
// and get_account (action version) read the same, but only here can the check be turned off or asked at once,
// and only here can Cubex update itself: self_update says how this install updates and how the last update from
// here went (lib/self-update.ts).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { setUpdateCheck, readReleaseState } from '../lib/release-store';
import { checkReleaseNow } from '../services/release-check';
import { versionInfo } from '../services/version-info';
import { startUpdate, updateHow, updateRun } from '../lib/self-update';

const router = express.Router();
router.use('/version', authenticateToken);

const answer = (userId: string) => ({ ...versionInfo(userId), self_update: { how: updateHow(), run: updateRun() } });

router.get('/version', (req: AuthRequest, res) => {
  res.json(answer(req.userId!));
});

// { update_check: boolean }. Off deletes the kept answer.
router.put('/version', (req: AuthRequest, res) => {
  try {
    const { update_check: on } = (req.body ?? {}) as { update_check?: unknown };
    if (typeof on !== 'boolean') return res.status(400).json({ error: 'update_check must be true or false.' });
    setUpdateCheck(req.userId!, on);
    res.json(answer(req.userId!));
  } catch (error) {
    console.error('Set update check error:', error);
    res.status(500).json({ error: 'Failed to save the setting' });
  }
});

// "Check now": asks GitHub at once, or answers from the last check when it went out under a minute ago
// (asked false). reached false: no answer (offline, rate limited); what was kept stays.
router.post('/version/check', async (req: AuthRequest, res) => {
  try {
    if (!readReleaseState(req.userId!).updateCheck) {
      return res.status(409).json({ error: 'The release check is turned off.' });
    }
    const { reached, asked } = await checkReleaseNow(req.userId!);
    res.json({ reached, asked, ...answer(req.userId!) });
  } catch (error) {
    console.error('Release check error:', error);
    res.status(500).json({ error: 'Failed to check for a new release' });
  }
});

// "Update now": starts the update to the latest release the check found, then answers at once (202); the page
// waits for the server to answer on the new version. A signed-in person only: an access token has no session.
// 400 when this install doesn't update this way (the message says what to run), 409 when it can't now.
router.post('/version/update', (req: AuthRequest, res) => {
  try {
    const out = startUpdate(versionInfo(req.userId!).latest_release?.version ?? null);
    if ('fail' in out) return res.status(out.fail === 'how' ? 400 : 409).json({ error: out.message });
    res.status(202).json(answer(req.userId!));
  } catch (error) {
    console.error('Start update error:', error);
    res.status(500).json({ error: 'Failed to start the update' });
  }
});

export default router;
