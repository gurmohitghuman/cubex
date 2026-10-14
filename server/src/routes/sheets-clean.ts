// The app's Clean data dialog: POST /:id/clean-columns creates a clean column
// (or changes one, or cleans it again) and POST /:id/clean-columns/preview
// shows the first rows before and after (a read: allowed while the sheet is
// busy). One implementation with /api/v1 and MCP (services/clean-column.ts).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { CLEAN_APP_WAIT_MS } from '../lib/constants';
import { runFailHttpStatus } from '../services/run-shared';
import { startCleanColumn, type CleanColumnInput } from '../services/clean-column';
import { previewCleanColumn } from '../services/clean-preview';
import { waitForCleanFill } from '../services/clean-fill';

const router = express.Router();
router.use(authenticateToken);

const inputOf = (body: unknown): CleanColumnInput => {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return {
    source: b.source, cleaner: b.cleaner, column: b.column, options: b.options,
    autoRun: typeof b.autoRun === 'boolean' ? b.autoRun : undefined,
  };
};

router.post('/:id/clean-columns/preview', (req: AuthRequest, res) => {
  try {
    const out = previewCleanColumn(req.userId!, req.params.id, inputOf(req.body));
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('Clean column preview error:', error);
    res.status(500).json({ error: 'Failed to preview the clean column' });
  }
});

// Answers once the fill is done or after CLEAN_APP_WAIT_MS: the tab reloads
// into the values, or shows ⏳ until the fill's end reloads it.
router.post('/:id/clean-columns', async (req: AuthRequest, res) => {
  try {
    const out = await startCleanColumn(req.userId!, req.params.id, inputOf(req.body));
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    const rec = await waitForCleanFill(out.ok.id, CLEAN_APP_WAIT_MS);
    res.json({ column: out.ok.column, created: out.ok.created, status: rec?.fill_status ?? 'done' });
  } catch (error) {
    console.error('Clean column error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to clean the column' });
  }
});

export default router;
