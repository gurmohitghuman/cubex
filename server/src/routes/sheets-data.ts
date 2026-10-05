import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { MAX_COLUMNS_PER_SHEET, MAX_ROWS_PER_SHEET } from '../lib/constants';
import { verifySheetOwnership } from '../lib/sql-helpers';
import { getLockedRunColumns } from './sheets-shared';
import { parseDataBody } from './sheets-data-validate';
import { applyDataWrite } from './sheets-data-write';

const router = express.Router();
router.use(authenticateToken);

// PUT /:id/data — cell upserts. Caps + immediate-mode transaction so two concurrent batch
// edits can't both pass the cap check and both insert past MAX_COLUMNS/ROWS.
router.put('/:id/data', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const parsed = parseDataBody(req.body);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const { mode, updates, clientGen } = parsed;

    const sheet = verifySheetOwnership(id, req.userId!);
    if (!sheet) return res.status(404).json({ error: 'Sheet not found' });

    // Optimistic-concurrency fence (migration 021). These updates target rows by
    // row_index; if the sheet was physically sorted / replace-imported since the
    // client last loaded, those indices now mean DIFFERENT rows. When the client
    // tells us the generation it saw and it no longer matches, reject so it
    // reloads instead of writing blind. (No await before the write transaction
    // below and only sort/CSV — both synchronous API handlers — bump the
    // counter, so this check can't be raced.) Omitted generation = legacy
    // client → skip the check (backwards compatible).
    if (typeof clientGen === 'number') {
      const cur = db.prepare('SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?')
        .get(id, req.userId!) as { row_generation: number } | undefined;
      if (cur && cur.row_generation !== clientGen) {
        return res.status(409).json({
          error: 'This sheet was reordered elsewhere. Reload to get the latest before editing.',
          currentGeneration: cur.row_generation,
        });
      }
    }

    // Columns an active run is writing into per-row. A cell edit or preview-commit
    // that lands here races the AI/HTTP worker's json_set (ai-row.ts/http-row.ts).
    // Sort/bulk-delete take a sheet-WIDE active-run guard; a cell edit only collides
    // on the run's OWN output columns, so we skip just those and persist the rest —
    // a blanket 409 would strand every edit on the sheet (incl. unrelated columns in
    // the same debounced batch) for the whole run. See getLockedRunColumns.
    const lockedColumns = getLockedRunColumns(id, req.userId!);

    const result = applyDataWrite({ id, userId: req.userId!, mode, updates, lockedColumns });

    if (result.nameError) return res.status(400).json({ error: result.nameError });
    if (result.capError) {
      return res.status(400).json({
        error: result.capError.kind === 'columns'
          ? `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet).`
          : `Row limit reached (${MAX_ROWS_PER_SHEET} per sheet).`,
      });
    }

    // `skipped` (>0 only in update mode) lets the client detect a stale view —
    // its edit targeted a row/column the server no longer has. `lockedColumns`
    // names the columns an active run owns whose edits we dropped to avoid racing
    // the worker. Either way we still 200 (the live, non-conflicting cells saved);
    // the client reloads (stale) or warns the user to retry after the run (locked).
    res.json({
      message: 'Sheet updated successfully',
      skipped: result.skipped,
      skippedCells: result.skippedCells,
      lockedColumns: result.lockedColumns,
      // Cells dropped for exceeding the basic-cell size cap (manual edits). The
      // client purges these from its autosave queue + toasts, same as
      // skippedCells/lockedColumns — a 200 so the rest of the batch persists.
      oversizeCells: result.oversizeCells,
    });
  } catch (error) {
    console.error('Update sheet error:', error);
    res.status(500).json({ error: 'Failed to update sheet data' });
  }
});

export default router;
