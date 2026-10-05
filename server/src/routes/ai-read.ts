import express from 'express';
import { aiRunDataColumn, type AiRunDataColumnFields } from '../lib/ai-data-column';
import { db } from '../lib/db';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { type AIRunRow } from '../services/ai-runner';

const router = express.Router();
router.use(authenticateToken);

router.get('/runs/:id', (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const run = db.prepare('SELECT * FROM ai_runs WHERE id = ? AND user_id = ?')
      .get(id, req.userId!) as AIRunRow | undefined;
    if (!run) return res.status(404).json({ error: 'AI run not found' });

    const results = db.prepare(
      'SELECT * FROM ai_results WHERE run_id = ? AND user_id = ? ORDER BY row_index ASC',
    ).all(id, req.userId!);
    res.json({ run, results });
  } catch (error) {
    console.error('Get AI run error:', error);
    res.status(500).json({ error: 'Failed to fetch AI run' });
  }
});

router.get('/runs', (req: AuthRequest, res) => {
  try {
    const { sheetId } = req.query as { sheetId?: string };
    if (!sheetId) return res.status(400).json({ error: 'sheetId is required' });
    res.json(db.prepare(`
      SELECT * FROM ai_runs WHERE sheet_id = ? AND user_id = ?
      ORDER BY created_at DESC
    `).all(sheetId, req.userId!));
  } catch (error) {
    console.error('Get AI runs error:', error);
    res.status(500).json({ error: 'Failed to get AI runs' });
  }
});

// The sources behind one "(Data)" cell: at this row, the newest result with
// sources from the runs whose "(Data)" column this is (aiRunDataColumn, the rule
// locks and column types use). Looked up per click through (run_id, row_index),
// so the grid loads nothing about results up front: a sheet can hold a million.
router.get('/sheets/:sheetId/sources', (req: AuthRequest, res) => {
  try {
    const { sheetId } = req.params;
    const rowIndex = Number(req.query.row_index);
    const column = typeof req.query.column === 'string' ? req.query.column : '';
    if (!Number.isSafeInteger(rowIndex) || rowIndex < 0 || !column) {
      return res.status(400).json({ error: 'row_index and column are required' });
    }
    const runs = db.prepare(`
      SELECT id, column_name, output_columns, data_column, use_openrouter_web_search FROM ai_runs
      WHERE sheet_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC
    `).all(sheetId, req.userId!) as Array<AiRunDataColumnFields & { id: string }>;
    const sourced = db.prepare(`
      SELECT scraped_data FROM ai_results
      WHERE run_id = ? AND row_index = ? AND user_id = ? AND scraped_data IS NOT NULL
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `);
    // Newest run first; one that has nothing at this row (a rerun of other
    // rows) falls through to the run whose sources the cell still shows.
    for (const run of runs) {
      if (aiRunDataColumn(run) !== column) continue;
      const hit = sourced.get(run.id, rowIndex, req.userId!) as { scraped_data: string } | undefined;
      if (!hit) continue;
      try {
        return res.json({ scrapedData: JSON.parse(hit.scraped_data) });
      } catch {
        return res.status(500).json({ error: 'Failed to parse scraped data' });
      }
    }
    res.json({ scrapedData: null });
  } catch (error) {
    console.error('Get cell sources error:', error);
    res.status(500).json({ error: 'Failed to get sources' });
  }
});

export default router;
