// Settings → Account → Version: the running version, the latest release and whether the daily check
// is on (services/version-info.ts). Cookie session only (mounted under /api/settings); GET /v1/version
// and get_version read the same, but only here can the check be turned off or asked at once.
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { setUpdateCheck, readReleaseState } from '../lib/release-store';
import { checkReleaseNow } from '../services/release-check';
import { versionInfo } from '../services/version-info';

const router = express.Router();
router.use('/version', authenticateToken);

router.get('/version', (req: AuthRequest, res) => {
  res.json(versionInfo(req.userId!));
});

// { update_check: boolean }. Off deletes the kept answer.
router.put('/version', (req: AuthRequest, res) => {
  try {
    const { update_check: on } = (req.body ?? {}) as { update_check?: unknown };
    if (typeof on !== 'boolean') return res.status(400).json({ error: 'update_check must be true or false.' });
    setUpdateCheck(req.userId!, on);
    res.json(versionInfo(req.userId!));
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
    res.json({ reached, asked, ...versionInfo(req.userId!) });
  } catch (error) {
    console.error('Release check error:', error);
    res.status(500).json({ error: 'Failed to check for a new release' });
  }
});

export default router;
