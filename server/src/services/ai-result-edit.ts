// Editing one stored AI result (the app's PUT /api/ai/results/:id; a commit
// later writes accepted ones into the sheet). A result of a run whose sheet,
// or its table, is in the trash is as gone as its sheet, as the commit says
// too. The check looks up the result's own run (EXISTS on it, by its primary
// key), so an edit costs the same however many runs the user has: auto-run
// adds a run per batch.
import { db } from '../lib/db';

// False when there is no such result of a live sheet's run.
export function editAiResult(userId: string, id: string, value: string, status: string): boolean {
  return db.prepare(`
    UPDATE ai_results SET output_value = ?, status = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM ai_runs r JOIN sheets s ON s.id = r.sheet_id
      WHERE r.id = ai_results.run_id AND r.user_id = ? AND s.trash_id IS NULL)
  `).run(value, status, id, userId, userId).changes > 0;
}
