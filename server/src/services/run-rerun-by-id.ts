// Rerun addressed by RUN ID — the programmatic surfaces' entry into the
// column-keyed rerun services. The UI reruns "the column" (it shows one run
// per column); an API client holds a run id, so we resolve id → column and
// refuse superseded runs: a rerun always clones the column's LATEST config,
// and silently rerunning under a stale id would surprise the caller (same
// guard as the AI commit route).
import { db } from '../lib/db';
import { httpRunSecretRefsRequiringScope } from '../lib/http-secrets-scan';
import { rerunAiColumn, RerunOutcome } from './ai-run-rerun';
import { AiRerunMode } from './ai-rerun-modes';
import { rerunHttpColumn } from './http-run-rerun';
import { resolveRowIdsToIndexes } from './run-shared';

// Names the latest run, so a caller with no run list can go straight to it.
const superseded = (latestId: string): string =>
  `This run has been superseded by a newer run on the same column. Rerun the latest run instead: ${latestId}.`;

// Resolve optional stable row ids → row_index values; shared by both kinds.
function resolveTargets(
  sheetId: string, userId: string, rowIds: string[] | undefined,
): { indexes?: number[] } | { error: string } {
  if (!rowIds) return {};
  const r = resolveRowIdsToIndexes(sheetId, userId, rowIds);
  if ('error' in r) return r;
  return { indexes: r.indexes };
}

export async function rerunAiRunById(
  userId: string, runId: string,
  opts: { rowIds?: string[]; mode?: AiRerunMode } = {},
): Promise<RerunOutcome> {
  const run = db.prepare(
    'SELECT id, sheet_id, column_name FROM ai_runs WHERE id = ? AND user_id = ?',
  ).get(runId, userId) as { id: string; sheet_id: string; column_name: string } | undefined;
  if (!run) return { fail: 'not_found', message: 'AI run not found' };

  // Tie-break on rowid (true insert order) so two runs sharing a created_at
  // second can't both consider themselves latest — matches the AI clone query
  // in ai-run-rerun.ts so the gate and the clone agree on "latest".
  const latest = db.prepare(`
    SELECT id FROM ai_runs WHERE sheet_id = ? AND user_id = ? AND column_name = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(run.sheet_id, userId, run.column_name) as { id: string } | undefined;
  if (latest && latest.id !== run.id) return { fail: 'conflict', message: superseded(latest.id) };

  const t = resolveTargets(run.sheet_id, userId, opts.rowIds);
  if ('error' in t) return { fail: 'bad_request', message: t.error };

  // The rerun service keys on the BASE column name and re-appends " (Output)".
  const baseColumnName = run.column_name.replace(/ \(Output\)$/, '');
  return rerunAiColumn(userId, {
    sheetId: run.sheet_id, baseColumnName, rowIndices: t.indexes, mode: opts.mode,
  });
}

export async function rerunHttpRunById(
  userId: string, runId: string,
  opts: { rowIds?: string[]; mode?: 'missing' | 'all'; hasSecretsScope: boolean },
): Promise<RerunOutcome> {
  const run = db.prepare(
    'SELECT id, sheet_id, master_column_name FROM http_runs WHERE id = ? AND user_id = ?',
  ).get(runId, userId) as { id: string; sheet_id: string; master_column_name: string | null } | undefined;
  if (!run) return { fail: 'not_found', message: 'HTTP run not found' };
  if (!run.master_column_name) {
    return { fail: 'bad_request', message: 'This run has no status column, so it cannot be re-run.' };
  }

  // The rerun clones the column's LATEST run (config + allow_secrets), so the
  // secrets gate must scan THAT run's config — it's what the worker executes.
  // rowid DESC = true insert order, IDENTICAL to rerunHttpColumn's clone query,
  // so the gate authorizes exactly the run that gets cloned.
  const latest = db.prepare(`
    SELECT id, config, allow_secrets FROM http_runs
    WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(run.sheet_id, userId, run.master_column_name) as
    { id: string; config: string | null; allow_secrets: number } | undefined;
  if (latest && latest.id !== run.id) return { fail: 'conflict', message: superseded(latest.id) };

  // A run-scope PAT without 'secrets' must not rerun a run whose (permissive)
  // config references a saved key — the clone keeps allow_secrets=1 and the
  // worker would inject the decrypted key. See http-secrets-scan.ts.
  if (latest) {
    const refs = httpRunSecretRefsRequiringScope(userId, latest, opts.hasSecretsScope);
    if (refs.length > 0) {
      return {
        fail: 'forbidden',
        message: `This run references saved API key(s): ${refs.join(', ')}. Re-running it requires the 'secrets' scope.`,
      };
    }
  }

  const t = resolveTargets(run.sheet_id, userId, opts.rowIds);
  if ('error' in t) return { fail: 'bad_request', message: t.error };

  return rerunHttpColumn(userId, {
    sheetId: run.sheet_id, masterColumnName: run.master_column_name,
    mode: opts.mode, rowIndices: t.indexes,
    // A no-'secrets' caller's rerun produces a FROZEN clone: even a key created
    // after the gate check above can never resolve. A secrets caller keeps the
    // parent's policy (copy). See http-run-rerun.ts forceAllowSecrets.
    forceAllowSecrets: opts.hasSecretsScope ? undefined : false,
  });
}
