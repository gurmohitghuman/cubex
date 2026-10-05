import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { MAX_ROWS_PER_SHEET } from '../lib/constants';
import { countColumnsAndRows, purgeResultsForRows, touchSheet, verifySheetOwnership } from '../lib/sql-helpers';
import { nextRowIndex } from '../lib/sheet-busy';

const router = express.Router();
router.use(authenticateToken);

// Max blank rows one Add-Rows action can request. The 10k per-sheet cap still
// applies on top; this just bounds a single click so a fat-fingered "10000000"
// can't try to insert millions in one transaction.
const MAX_ROWS_PER_ADD = 1000;

// POST /:id/rows — append N blank rows at MAX(row_index)+1 .. +N. Mirrors the
// add-column route (sheets-columns-mutate.ts): verify ownership, cap-check,
// mutate in a transaction, touch the sheet. There is no row-order analogue to
// maintain — rows are ordered solely by row_index in SQL (no row_order table).
// Body: { count?: number } — defaults to 1, clamped to [1, MAX_ROWS_PER_ADD].
router.post('/:id/rows', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const sheet = verifySheetOwnership(id, req.userId!);
    if (!sheet) return res.status(404).json({ error: 'Sheet not found' });

    // Clamp the requested count. Non-numeric / missing → 1. The server is the
    // authority; the client also clamps but a direct API call must be bounded too.
    const raw = (req.body as { count?: unknown }).count;
    const count = (typeof raw === 'number' && Number.isFinite(raw))
      ? Math.max(1, Math.min(Math.floor(raw), MAX_ROWS_PER_ADD))
      : 1;

    // Cap check + inserts in ONE immediate-mode transaction. We hold the writer
    // lock across the count + inserts so concurrent adds can't both pass the cap.
    // Reject the WHOLE batch if it would exceed the per-sheet limit (no partial
    // insert) — matches CSV import's upfront rejection.
    let capRemaining = -1;
    const newRowIndexes: number[] = [];
    db.transaction(() => {
      const { rows: currentRows } = countColumnsAndRows(id, req.userId!);
      if (currentRows + count > MAX_ROWS_PER_SHEET) {
        capRemaining = Math.max(0, MAX_ROWS_PER_SHEET - currentRows);
        return;
      }

      let nextIndex = nextRowIndex(id, req.userId!);

      const insert = db.prepare("INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, '{}')");
      for (let i = 0; i < count; i++) {
        insert.run(uuidv4(), id, req.userId!, nextIndex);
        newRowIndexes.push(nextIndex);
        nextIndex++;
      }
      touchSheet(id, req.userId!);
    }).immediate();

    if (capRemaining >= 0) {
      return res.status(400).json({
        error: `Row limit reached (${MAX_ROWS_PER_SHEET} per sheet). You can add at most ${capRemaining} more row${capRemaining === 1 ? '' : 's'}.`,
      });
    }

    res.json({ message: 'Rows added successfully', rowIndexes: newRowIndexes });
  } catch (error) {
    console.error('Add rows error:', error);
    res.status(500).json({ error: 'Failed to add rows' });
  }
});

// POST /:id/rows/bulk-delete — accepts { rowIndices: number[] } in the body
// and deletes all matching rows in a SINGLE transaction with one round-trip.
// Replaces the old client-side "fire 1000 parallel DELETE requests" pattern
// that tripped the global rate limiter and hammered the SQLite writer slot.
// Capped at 10000 indices per call to bound DB writer hold time; 'Select all'
// on a full sheet (max 50k rows) requires 5 calls — still 200× fewer HTTP
// requests than the per-row delete path.
const MAX_BULK_DELETE_ROWS = 10000;
router.post('/:id/rows/bulk-delete', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { rowIndices } = req.body as { rowIndices?: unknown };

    if (!Array.isArray(rowIndices) || rowIndices.length === 0) {
      return res.status(400).json({ error: 'rowIndices must be a non-empty array of integers.' });
    }
    if (rowIndices.length > MAX_BULK_DELETE_ROWS) {
      return res.status(400).json({
        error: `Cannot delete more than ${MAX_BULK_DELETE_ROWS} rows in a single call. Send multiple requests.`,
      });
    }
    // Coerce + validate every entry. A single NaN or negative index would
    // silently no-op against SQLite; reject the whole request so the client
    // gets a clean error instead of an inconsistent partial result.
    const indices: number[] = [];
    for (const r of rowIndices) {
      const n = typeof r === 'number' ? r : parseInt(String(r), 10);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({ error: 'Every rowIndex must be a non-negative integer.' });
      }
      indices.push(n);
    }
    // De-dupe defensively (saves cycles when the client passes the same row
    // index twice from a stale selection).
    const unique = Array.from(new Set(indices));

    const sheet = verifySheetOwnership(id, req.userId!);
    if (!sheet) return res.status(404).json({ error: 'Sheet not found' });

    // Block bulk delete while ANY run is active on this sheet. Same rationale as
    // the sort guard (sheets-sort.ts): a delete removes row_index values that an
    // in-flight runner is still writing to. purgeResultsForRows clears the
    // results that exist NOW, but a worker mid-API-call still INSERTs into
    // {ai,http}_results for the deleted row afterward (ai-row.ts) — orphaned
    // results that a later sort rebinds to the wrong live row, plus wasted API
    // credits. Sheet-wide (any run, any column): a deleted row affects every
    // column's results, not just the run's target column.
    const activeRun = db.prepare(`
      SELECT 1 FROM ai_runs WHERE sheet_id = ? AND user_id = ? AND status IN ('pending','running','paused')
      UNION SELECT 1 FROM http_runs WHERE sheet_id = ? AND user_id = ? AND status IN ('pending','running','paused')
      LIMIT 1
    `).get(id, req.userId!, id, req.userId!);
    if (activeRun) return res.status(409).json({
      error: 'Cannot delete rows while a run is active on this sheet. Stop or finish the run first.',
    });

    // Same row_generation fence as PUT /:id/data (migration 021): deleting by
    // stale row_index after a sort/replace would delete the WRONG logical rows.
    // Unlike the cell-edit PUT (which skips the check for legacy clients to stay
    // back-compatible), bulk-delete is a DESTRUCTIVE structural mutation, so the
    // fence is REQUIRED: an omitted generation is a hard 400, not a skipped check.
    // The first-party client always sends it (rowGenerationRef, seeded on every
    // sheet load — SheetPage.tsx), so this only rejects stale tabs and direct API
    // calls that would otherwise delete blind.
    const clientGen = (req.body as { rowGeneration?: unknown }).rowGeneration;
    if (typeof clientGen !== 'number') {
      return res.status(400).json({ error: 'rowGeneration is required to delete rows.' });
    }
    const cur = db.prepare('SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?')
      .get(id, req.userId!) as { row_generation: number } | undefined;
    if (cur && cur.row_generation !== clientGen) {
      return res.status(409).json({
        error: 'This sheet was reordered elsewhere. Reload before deleting rows.',
        currentGeneration: cur.row_generation,
      });
    }

    let deletedCount = 0;
    db.transaction(() => {
      // Build one DELETE … WHERE row_index IN (?, ?, …) statement. Faster
      // than looping prepare().run() per index inside the transaction (each
      // .run() round-trips through better-sqlite3's bridge).
      const placeholders = unique.map(() => '?').join(',');
      const stmt = db.prepare(
        `DELETE FROM rows WHERE sheet_id = ? AND user_id = ? AND row_index IN (${placeholders})`,
      );
      const result = stmt.run(id, req.userId!, ...unique);
      deletedCount = result.changes;
      // Purge per-row AI/HTTP results for the deleted indices IN THE SAME
      // transaction. Otherwise they orphan: a later sort rebinds them to a
      // different live row, and a preview-commit resurrects the deleted row
      // (it upserts by row_index). See purgeResultsForRows.
      purgeResultsForRows(id, req.userId!, unique);
      touchSheet(id, req.userId!);
    })();

    res.json({ message: `${deletedCount} row${deletedCount === 1 ? '' : 's'} deleted`, deletedCount });
  } catch (error) {
    console.error('Bulk delete rows error:', error);
    res.status(500).json({ error: 'Failed to delete rows' });
  }
});

export default router;
