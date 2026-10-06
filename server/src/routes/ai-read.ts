import express from 'express';
import { aiRunDataColumn, type AiRunDataColumnFields } from '../lib/ai-data-column';
import { parseSearchQueries } from '../lib/ai-data-cell';
import { aiRowOutcomes } from '../services/ai-run-outcomes';
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
    // What the run has cost and searched so far (an index-only count).
    const { cost_usd, searches } = aiRowOutcomes(id);
    res.json({ run, results, spend: { cost_usd, searches } });
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

// The sources behind one "(Data)" cell, and what the row searched for and
// cost: at this row, the newest result with any of them from the runs whose
// "(Data)" column this is (aiRunDataColumn, the rule locks and column types
// use). Looked up per click through (run_id, row_index), so the grid loads
// nothing about results up front: a sheet can hold a million.
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
      SELECT scraped_data, web_searches, web_search_queries, cost_usd FROM ai_results
      WHERE run_id = ? AND row_index = ? AND user_id = ?
        AND (scraped_data IS NOT NULL OR web_search_queries IS NOT NULL OR cost_usd IS NOT NULL)
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `);
    // Newest run first; one that has nothing at this row (a rerun of other
    // rows) falls through to the run whose sources the cell still shows.
    for (const run of runs) {
      if (aiRunDataColumn(run) !== column) continue;
      const hit = sourced.get(run.id, rowIndex, req.userId!) as
        { scraped_data: string | null; web_searches: number | null; web_search_queries: string | null; cost_usd: number | null } | undefined;
      if (!hit) continue;
      try {
        const queries = parseSearchQueries(hit.web_search_queries);
        return res.json({
          scrapedData: hit.scraped_data ? JSON.parse(hit.scraped_data) : null,
          search: queries ? { searches: hit.web_searches ?? 0, queries } : null,
          costUsd: hit.cost_usd,
        });
      } catch {
        return res.status(500).json({ error: 'Failed to parse scraped data' });
      }
    }
    res.json({ scrapedData: null, search: null, costUsd: null });
  } catch (error) {
    console.error('Get cell sources error:', error);
    res.status(500).json({ error: 'Failed to get sources' });
  }
});

export default router;
