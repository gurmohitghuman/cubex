import express from 'express';
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

router.get('/sheets/:sheetId/results', (req: AuthRequest, res) => {
  try {
    const { sheetId } = req.params;
    const runs = db.prepare(
      'SELECT id, column_name FROM ai_runs WHERE sheet_id = ? AND user_id = ?',
    ).all(sheetId, req.userId!) as Array<{ id: string; column_name: string }>;

    const runIdToColumn: Record<string, string> = {};
    runs.forEach(r => { runIdToColumn[r.id] = r.column_name; });
    const runIds = Object.keys(runIdToColumn);
    if (runIds.length === 0) return res.json([]);

    const placeholders = runIds.map(() => '?').join(',');
    const results = db.prepare(`
      SELECT * FROM ai_results
      WHERE run_id IN (${placeholders}) AND user_id = ?
      ORDER BY row_index ASC
    `).all(...runIds, req.userId!) as any[];

    res.json(results.map(r => ({ ...r, column_name: runIdToColumn[r.run_id] || null })));
  } catch (error) {
    console.error('Error getting AI results for sheet:', error);
    res.status(500).json({ error: 'Failed to get AI results for sheet' });
  }
});

router.get('/results/:resultId/scraped-data', (req: AuthRequest, res) => {
  try {
    const { resultId } = req.params;
    const result = db.prepare('SELECT scraped_data FROM ai_results WHERE id = ? AND user_id = ?')
      .get(resultId, req.userId!) as { scraped_data: string | null } | undefined;

    if (!result) return res.status(404).json({ error: 'Result not found' });
    if (!result.scraped_data) {
      return res.json({ scrapedData: null, message: 'No scraped data available for this row' });
    }
    try {
      res.json({ scrapedData: JSON.parse(result.scraped_data) });
    } catch {
      res.status(500).json({ error: 'Failed to parse scraped data' });
    }
  } catch (error) {
    console.error('Get scraped data error:', error);
    res.status(500).json({ error: 'Failed to get scraped data' });
  }
});

export default router;
