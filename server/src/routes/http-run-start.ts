import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { type HTTPAPIConfig } from '../lib/http-request';
import { startHttpRun } from '../services/http-run-start';
import { runFailHttpStatus } from '../services/run-shared';

// Thin wrapper over services/http-run-start.ts (shared with /api/v1 and the
// MCP run_http_enrichment tool). Cookie-authed UI starts always allow saved-
// key resolution (allowSecrets: true) — the account owner authored the config
// in their own browser; the 'secrets' scope gate is a PAT-surface concern.
const router = express.Router();

router.post('/run', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const { sheetId, config, masterColumnName, saveOnly }: {
      sheetId: string; config: HTTPAPIConfig; masterColumnName?: string; saveOnly?: unknown;
    } = req.body;
    if (!sheetId || !config) return res.status(400).json({ error: 'Sheet ID and config are required' });

    // The edit dialog's Save: the setup becomes the column's and nothing runs (services/http-setup-change.ts).
    const result = await startHttpRun(req.userId!, {
      sheetId, config, masterColumnName, allowSecrets: true, saveOnly: saveOnly === true,
    });
    if ('fail' in result) return res.status(runFailHttpStatus(result)).json({ error: result.message });
    if (result.ok.saved) {
      return res.json({ saved: true, setupId: result.ok.runId, message: 'Setup saved. Nothing ran.',
        masterColumn: result.ok.masterColumn, mappedColumns: result.ok.mappedColumns });
    }

    res.json({ runId: result.ok.runId, message: 'HTTP run started and columns created' });
  } catch (error: any) {
    console.error('HTTP run start error:', error);
    res.status(500).json({ error: 'Failed to start HTTP run' });
  }
});

export default router;
