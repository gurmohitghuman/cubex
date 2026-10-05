import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { getDraft, deleteDraft } from '../lib/ai-drafts';

// AI Column draft hydration surface.
// Read + delete only — the draft is WRITTEN exclusively by /ai/preview (server-
// side, from the exact data the preview used) and CONSUMED by /ai/run. There is
// deliberately no PUT: a client-supplied draft would carry client-computed
// hashes, which the credit-reuse promotion must never trust.
const router = express.Router();
router.use(authenticateToken);

router.get('/drafts/:sheetId', (req: AuthRequest, res) => {
  try {
    const { sheetId } = req.params;
    if (!verifySheetOwnership(sheetId, req.userId!)) {
      return res.status(404).json({ error: 'Sheet not found' });
    }
    const draft = getDraft(req.userId!, sheetId);
    if (!draft) return res.json({ draft: null });

    // Preview results are only offered to the client when the sheet's physical
    // row order is unchanged since the preview (sort / CSV-replace bump
    // row_generation) — a stale preview's rowIndex values point at the wrong
    // rows. The config half of the draft is always safe to hydrate. Per-row
    // input freshness is NOT checked here (display is harmless); the strict
    // per-row check happens at promotion time in lib/ai-run-promote.ts.
    const sheet = db.prepare('SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?')
      .get(sheetId, req.userId!) as { row_generation: number } | undefined;
    const previewFresh = !!draft.previewResults
      && !!sheet && draft.rowGeneration === sheet.row_generation;

    // Return the LIVE row count, not the count stored at preview time —
    // appended rows (webhooks don't bump row_generation, by design) would
    // otherwise make a restored cost estimate undercount the run.
    const liveTargetRows = (db.prepare('SELECT COUNT(*) AS c FROM rows WHERE sheet_id = ? AND user_id = ?')
      .get(sheetId, req.userId!) as { c: number }).c;

    res.json({
      draft: {
        config: draft.config,
        // inputHash is server-internal — strip it from the wire.
        previewResults: previewFresh
          ? draft.previewResults!.map(({ rowIndex, value, error, promptTokens, completionTokens }) =>
              ({ rowIndex, value, error, promptTokens, completionTokens }))
          : null,
        runTargetRows: liveTargetRows,
      },
    });
  } catch (error) {
    console.error('Get AI draft error:', error);
    res.status(500).json({ error: 'Failed to fetch draft' });
  }
});

// Explicit reset: the modal's "Back to Configure" discards the saved draft
// (owner decision — Back means "I'm done with this attempt").
router.delete('/drafts/:sheetId', (req: AuthRequest, res) => {
  try {
    const { sheetId } = req.params;
    if (!verifySheetOwnership(sheetId, req.userId!)) {
      return res.status(404).json({ error: 'Sheet not found' });
    }
    deleteDraft(req.userId!, sheetId);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete AI draft error:', error);
    res.status(500).json({ error: 'Failed to delete draft' });
  }
});

export default router;
