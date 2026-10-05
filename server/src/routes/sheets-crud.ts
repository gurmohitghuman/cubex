import express from 'express';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import { MAX_AI_CONCURRENCY } from '../lib/constants';
import { setSheetDefaultModel } from '../services/ai-model-config';

const router = express.Router();
router.use(authenticateToken);

// Sheet create / rename / delete / reorder live in routes/tables-sheets.ts
// (mounted under /api/tables/:tableId/sheets).
// This file holds only per-sheet SETTINGS mutations (empty-filter, default model,
// default concurrency).

// There is no sort-state route: sort is a one-time physical reorder (POST
// /:id/sort in sheets-sort.ts, Google Sheets semantics), and sheets.sort_state
// is a vestigial column that is always NULL.

router.put('/:id/empty-filter', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const raw = req.body?.emptyFilter;

    // Validate empty filter. null clears it. Otherwise it must be
    // Record<string, 'empty' | 'not_empty'>. Arbitrary user JSON in this
    // column would later be read back and applied to every visible row.
    let stored: string | null = null;
    if (raw !== null && raw !== undefined) {
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return res.status(400).json({ error: 'emptyFilter must be an object mapping column names to "empty" or "not_empty", or null.' });
      }
      const cleaned: Record<string, 'empty' | 'not_empty'> = {};
      for (const [col, val] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof col !== 'string' || col.trim() === '') {
          return res.status(400).json({ error: 'emptyFilter keys must be non-empty column names.' });
        }
        if (val !== 'empty' && val !== 'not_empty') {
          return res.status(400).json({ error: `emptyFilter["${col}"] must be 'empty' or 'not_empty'.` });
        }
        cleaned[col] = val;
      }
      // Empty object == no filter; store NULL so the loader hydrates to {}.
      stored = Object.keys(cleaned).length === 0 ? null : JSON.stringify(cleaned);
    }

    const sheet = verifySheetOwnership(id, req.userId!);
    if (!sheet) return res.status(404).json({ error: 'Sheet not found' });

    // Reject filters that reference columns the sheet doesn't have. A
    // not_empty filter on a typo'd or already-deleted column matches zero
    // rows, so GET /:id returns an empty page — and a deleted column has no
    // header UI to clear the filter, leaving the sheet stuck looking empty.
    // Same precedent as the sort route (sheets-sort.ts). Skipped when storing
    // NULL (clearing the filter), which never references a column.
    if (stored !== null) {
      const validCols = new Set(getSheetColumns(id, req.userId!));
      const parsed = JSON.parse(stored) as Record<string, 'empty' | 'not_empty'>;
      const missing = Object.keys(parsed).filter(col => !validCols.has(col));
      if (missing.length > 0) {
        return res.status(400).json({
          error: `Empty filter references unknown column${missing.length > 1 ? 's' : ''}: ${missing.map(c => `"${c}"`).join(', ')}.`,
        });
      }
    }

    db.prepare(`
      UPDATE sheets SET empty_filter = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `).run(stored, id, req.userId!);

    res.json({ message: 'Empty filter updated successfully' });
  } catch (error) {
    console.error('Update empty filter error:', error);
    res.status(500).json({ error: 'Failed to update empty filter' });
  }
});

// Per-column "text contains" filter (migration 031) — the text-search sibling of
// the empty filter above; same validate → unknown-column check → store shape.
// Body: { columnFilters: { col: { type: 'contains', value: string } } | null }.
router.put('/:id/column-filters', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const raw = req.body?.columnFilters;

    let stored: string | null = null;
    if (raw !== null && raw !== undefined) {
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return res.status(400).json({ error: 'columnFilters must be an object mapping column names to a condition, or null.' });
      }
      const cleaned: Record<string, { type: 'contains'; value: string }> = {};
      for (const [col, cond] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof col !== 'string' || col.trim() === '') {
          return res.status(400).json({ error: 'columnFilters keys must be non-empty column names.' });
        }
        if (!cond || typeof cond !== 'object' || (cond as any).type !== 'contains' || typeof (cond as any).value !== 'string') {
          return res.status(400).json({ error: `columnFilters["${col}"] must be { type: 'contains', value: string }.` });
        }
        // An empty/whitespace value is not a filter — drop it (client also treats
        // clearing the input as "remove this column's filter").
        if ((cond as any).value.trim() === '') continue;
        cleaned[col] = { type: 'contains', value: (cond as any).value };
      }
      stored = Object.keys(cleaned).length === 0 ? null : JSON.stringify(cleaned);
    }

    const sheet = verifySheetOwnership(id, req.userId!);
    if (!sheet) return res.status(404).json({ error: 'Sheet not found' });

    // Reject filters on columns the sheet doesn't have (a deleted/typo'd column
    // would match zero rows with no header UI to clear it — same guard as the
    // empty-filter + sort routes). Skipped when clearing (NULL).
    if (stored !== null) {
      const validCols = new Set(getSheetColumns(id, req.userId!));
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      const missing = Object.keys(parsed).filter(col => !validCols.has(col));
      if (missing.length > 0) {
        return res.status(400).json({
          error: `Filter references unknown column${missing.length > 1 ? 's' : ''}: ${missing.map(c => `"${c}"`).join(', ')}.`,
        });
      }
    }

    db.prepare(`
      UPDATE sheets SET column_filters = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `).run(stored, id, req.userId!);

    res.json({ message: 'Column filters updated successfully' });
  } catch (error) {
    console.error('Update column filters error:', error);
    res.status(500).json({ error: 'Failed to update column filters' });
  }
});

// Thin wrapper over services/ai-model-config.ts (shared with the MCP
// set_default_model tool). Historical strictness preserved: a body without a
// `model` key is a 400, not a clear.
router.put('/:id/default-model', (req: AuthRequest, res) => {
  try {
    const { model } = req.body as { model?: unknown };
    if (model !== null && (typeof model !== 'string' || model.length > 200)) {
      return res.status(400).json({ error: 'Invalid model value' });
    }
    const result = setSheetDefaultModel(req.userId!, req.params.id, model);
    if ('fail' in result) {
      return res.status(result.fail === 'not_found' ? 404 : 400).json({ error: result.message });
    }
    res.json({ message: 'Default model updated successfully' });
  } catch (error) {
    console.error('Update default model error:', error);
    res.status(500).json({ error: 'Failed to update default model' });
  }
});

// Persist the per-sheet default AI concurrency (migration 025). Mirrors
// /default-model: the modal saves the user's slider choice here so it becomes
// the default next time. Clamped to [1, MAX_AI_CONCURRENCY]; null clears it.
router.put('/:id/default-concurrency', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { concurrency } = req.body as { concurrency?: number | null };
    let value: number | null;
    if (concurrency === null || concurrency === undefined) {
      value = null;
    } else if (typeof concurrency === 'number' && Number.isFinite(concurrency)) {
      value = Math.max(1, Math.min(Math.floor(concurrency), MAX_AI_CONCURRENCY));
    } else {
      return res.status(400).json({ error: 'Invalid concurrency value' });
    }

    const sheet = verifySheetOwnership(id, req.userId!);
    if (!sheet) return res.status(404).json({ error: 'Sheet not found' });

    db.prepare(`
      UPDATE sheets SET default_ai_concurrency = ?, updated_at = datetime('now')
      WHERE id = ? AND user_id = ?
    `).run(value, id, req.userId!);

    res.json({ message: 'Default concurrency updated successfully' });
  } catch (error) {
    console.error('Update default concurrency error:', error);
    res.status(500).json({ error: 'Failed to update default concurrency' });
  }
});

export default router;
