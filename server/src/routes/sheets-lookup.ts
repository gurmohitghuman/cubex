// The app's Lookup dialog: GET /:id/lookup-columns/targets lists the sheets it
// can look in (with their columns), POST /:id/lookup-columns/preview shows what
// it gives on the first rows (only reads: allowed while the sheet is busy) and
// POST /:id/lookup-columns creates a lookup column (or changes one). One
// implementation with /api/v1 and MCP (services/lookup-column.ts).
import express from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { LOOKUP_APP_WAIT_MS } from '../lib/constants';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { runFailHttpStatus } from '../services/run-shared';
import { startLookupColumn, type LookupColumnInput } from '../services/lookup-column';
import { previewLookupColumn } from '../services/lookup-preview';
import { lookupTargets } from '../services/lookup-targets';
import { waitForDerivedFill } from '../services/derived-fill';
import { lookupKind } from '../services/lookup-kind';

const router = express.Router();
router.use(authenticateToken);

const inputOf = (body: unknown): LookupColumnInput => {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return {
    column: b.column, sourceColumn: b.sourceColumn, otherSheetId: b.otherSheetId, matchColumn: b.matchColumn,
    match: b.match, returns: b.returns, returnColumn: b.returnColumn, returnColumns: b.returnColumns,
    limit: b.limit, autoRun: typeof b.autoRun === 'boolean' ? b.autoRun : undefined,
  };
};

router.get('/:id/lookup-columns/targets', (req: AuthRequest, res) => {
  try {
    if (!verifySheetOwnership(req.params.id, req.userId!)) return res.status(404).json({ error: 'Sheet not found' });
    res.json({ sheets: lookupTargets(req.userId!, req.params.id) });
  } catch (error) {
    console.error('Lookup targets error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to list the sheets' });
  }
});

router.post('/:id/lookup-columns/preview', (req: AuthRequest, res) => {
  try {
    const out = previewLookupColumn(req.userId!, req.params.id, inputOf(req.body));
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    res.json(out.ok);
  } catch (error) {
    console.error('Lookup column preview error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to preview the lookup' });
  }
});

// Answers once the fill is done or after LOOKUP_APP_WAIT_MS: the tab reloads
// into the values, or shows ⏳ until the fill's end reloads it.
router.post('/:id/lookup-columns', async (req: AuthRequest, res) => {
  try {
    const out = await startLookupColumn(req.userId!, req.params.id, inputOf(req.body));
    if ('fail' in out) return res.status(runFailHttpStatus(out)).json({ error: out.message });
    const rec = await waitForDerivedFill(lookupKind, out.ok.id, LOOKUP_APP_WAIT_MS);
    res.json({ column: out.ok.column, created: out.ok.created, status: rec?.fill_status ?? 'done' });
  } catch (error) {
    console.error('Lookup column error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to save the lookup column' });
  }
});

export default router;
