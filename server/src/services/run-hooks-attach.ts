// A run started over REST or MCP can name a webhook (webhook_id): that webhook
// hears when the run finishes, even one set to notify only runs that name it.
// The id is checked before the start; the run is linked right after it.
import { db } from '../lib/db';

export type RunTable = 'ai_runs' | 'http_runs' | 'setup_runs';

// null: no webhook named; a string: why the value can't be used.
export function webhookIdProblem(userId: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) return 'webhook_id must be the id of a run webhook.';
  const found = db.prepare('SELECT 1 FROM run_webhooks WHERE id = ? AND user_id = ?').get(value, userId);
  return found ? null
    : 'webhook_id doesn\'t match a run webhook. List them with list_run_webhooks or GET /api/v1/run-webhooks.';
}

const FINISHED: Record<RunTable, string[]> = {
  ai_runs: ['completed', 'failed', 'cancelled'],
  http_runs: ['completed', 'failed', 'cancelled'],
  setup_runs: ['done', 'failed', 'cancelled'],
};

// Links the webhook to a run just started. A run can finish before this runs (a
// sheet with nothing to do): then the trigger saw no webhook, so the notice for
// this webhook alone is queued here. One transaction, so a finish committing
// meanwhile is either before it (queued here) or after it (the trigger sees
// the webhook); never both, never neither.
export function attachRunWebhook(table: RunTable, runId: string, userId: string, webhookId: string): void {
  db.transaction(() => {
    db.prepare(`UPDATE ${table} SET webhook_id = ? WHERE id = ? AND user_id = ?`).run(webhookId, runId, userId);
    const run = db.prepare(`SELECT status, sheet_id FROM ${table} WHERE id = ? AND user_id = ?`)
      .get(runId, userId) as { status: string; sheet_id: string } | undefined;
    if (!run || !FINISHED[table].includes(run.status)) return;
    // A webhook for every run heard it from the trigger's notice already.
    const everyRun = db.prepare('SELECT every_run FROM run_webhooks WHERE id = ? AND user_id = ?').pluck()
      .get(webhookId, userId);
    if (everyRun === 1) return;
    const kind = table === 'setup_runs' ? 'setup' : table === 'ai_runs' ? 'ai' : kindOfHttpRun(runId);
    db.prepare(`INSERT INTO run_webhook_events (user_id, run_id, kind, sheet_id, status, webhook_id, named_only,
      finished_at) VALUES (?, ?, ?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
      .run(userId, runId, kind, run.sheet_id, run.status === 'done' ? 'completed' : run.status, webhookId);
  }).immediate();
}

function kindOfHttpRun(runId: string): 'http' | 'enrichment' {
  const enrichment = db.prepare(`SELECT 1 FROM http_runs WHERE id = ? AND config IS NOT NULL AND json_valid(config)
    AND json_type(config, '$.enrichment') = 'object'`).get(runId);
  return enrichment ? 'enrichment' : 'http';
}
