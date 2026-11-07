// A paused run about to resume, checked again the way its start was: what it reads may have changed while
// it was paused. An AI run's prompt (lib/prompt-ref-validate.ts): a column it names that is gone since
// ('bad_request', 400, as a start answers it), or one another run holds; an HTTP API, enrichment or waterfall
// run's request and inputs (lib/http-held-inputs.ts). A held column answers 'held' (409) with the shared words
// (lib/run-held-words.ts): its rows would send that run's ⏳ cells. The run's own columns never count (it holds
// them itself while paused). services/run-lifecycle.ts resumeRun asks, and a setup's resume, before it resumes
// any of its runs (services/setup-run-control.ts).
import { db } from './db';
import { promptRefsRefusal } from './prompt-ref-validate';
import { resumeHeldInputRefusal } from './http-held-inputs';
import { addAiRunColumns, type AiRunWrites } from './run-locked-columns';

export type ResumeInputRefusal = { fail: 'held' | 'bad_request'; message: string };

export function resumeInputRefusal(kind: 'ai' | 'http', runId: string, userId: string): ResumeInputRefusal | null {
  if (kind === 'http') {
    const held = resumeHeldInputRefusal(runId, userId);
    return held ? { fail: 'held', message: held } : null;
  }
  const run = db.prepare(`SELECT sheet_id, status, prompt, column_name, output_columns, data_column FROM ai_runs
    WHERE id = ? AND user_id = ?`).get(runId, userId) as
    (AiRunWrites & { sheet_id: string; status: string; prompt: string | null }) | undefined;
  if (!run || run.status !== 'paused' || !run.prompt) return null;
  const own = new Set<string>();
  addAiRunColumns(run, own);
  const refused = promptRefsRefusal(run.sheet_id, userId, run.prompt, [...own]);
  if (!refused) return null;
  return { fail: refused.held ? 'held' : 'bad_request', message: refused.message };
}
