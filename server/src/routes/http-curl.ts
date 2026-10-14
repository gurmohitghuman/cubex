import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { importCurlForApp } from '../services/curl-import-app';
import { runFailHttpStatus } from '../services/run-shared';

const router = express.Router();

// POST /api/http/curl  { sheetId, curl, keys? }
// "Paste a cURL command" in the HTTP column dialog: see services/curl-import-app.ts.
// The command can hold keys, so it is never logged; replies carry masked hints only.
router.post('/curl', authenticateToken, (req: AuthRequest, res) => {
  try {
    const { sheetId, curl, keys } = (req.body ?? {}) as { sheetId?: unknown; curl?: unknown; keys?: unknown };
    if (typeof sheetId !== 'string' || !sheetId) return res.status(400).json({ error: 'sheetId is required' });
    const r = importCurlForApp(req.userId!, sheetId, curl, keys);
    if ('fail' in r) return res.status(runFailHttpStatus(r)).json({ error: r.message });
    res.json(r.ok);
  } catch (error) {
    console.error('POST /api/http/curl error:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Failed to read the cURL command' });
  }
});

export default router;
