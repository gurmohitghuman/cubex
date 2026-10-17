// Carrying a sheet's column on: a setup step in 'again' mode (lib/setups/again.ts),
// started by setup-runner.ts. It goes through the column's own reruns, so its
// own settings apply, on the rows it hasn't done: an AI column's empty rows
// (blank, or left by its rule), an HTTP API column's missing rows, an
// enrichment's rows not enriched yet; only among the test rows when it's a
// test; a row its rule kept out only if the rule passes on it now. A run
// already working on the column is waited for, not refused (a paused one
// ends the setup with a message: nothing would resume it), and no row left
// to do counts as done. A clean or formula column that follows its columns
// needs no start: the step waits until its auto-run has worked out every row
// the steps before it wrote (followProgress). One that doesn't follow is
// filled again, free, with its own settings.
import { db } from '../lib/db';
import { mainColumn, type SetupStep } from '../lib/setups/spec';
import { cleanColumnFor } from '../lib/clean-columns';
import { formulaColumnFor } from '../lib/formula-columns';
import { rerunAiColumn } from './ai-run-rerun';
import { rerunHttpColumn } from './http-run-rerun';
import { rerunEnrichmentColumn } from './enrich-rerun';
import { startCleanColumn } from './clean-column';
import { startFormulaColumn } from './formula-column';
import { entryFor } from './autorun-entry';
import type { StepStarted } from './setup-step-start';
import type { RunFail } from './run-shared';

export type AgainStart =
  | { ok: StepStarted }
  | { follow: { kind: 'clean' | 'formula'; recordId: string } } // waits for its auto-run
  | { done: string }                                             // nothing left to do
  | { wait: true }                                               // a run on it is working: next sweep
  | RunFail;

const DONE_ALREADY = 'Every row was done already.';

const recordOf = (sheetId: string, userId: string, kind: 'clean' | 'formula', column: string) =>
  kind === 'clean' ? cleanColumnFor(sheetId, userId, column) : formulaColumnFor(sheetId, userId, column);

// Is the column's auto-run following its columns now (on, not paused, its fill done)?
export function derivedFollows(sheetId: string, userId: string, kind: 'clean' | 'formula', column: string): boolean {
  const rec = recordOf(sheetId, userId, kind, column);
  const e = entryFor(sheetId, userId, column);
  return !!rec && rec.fill_status !== 'failed' && !!e && e.enabled === 1 && e.kind === kind && !e.paused_reason;
}

// A followed column's step: 'done' once its auto-run has worked out every row
// written (or added) so far, 'stopped' when it no longer follows (it's filled again then).
export function followProgress(
  sheetId: string, userId: string, kind: 'clean' | 'formula', column: string,
): 'working' | 'done' | 'stopped' | 'gone' {
  const rec = recordOf(sheetId, userId, kind, column);
  if (!rec) return 'gone';
  if (!derivedFollows(sheetId, userId, kind, column)) return 'stopped';
  const e = entryFor(sheetId, userId, column)!;
  if (rec.fill_status === 'filling' || e.rescan) return 'working';
  const pending = db.prepare('SELECT 1 FROM autorun_pending WHERE autorun_id = ? LIMIT 1').get(e.id);
  const top = db.prepare('SELECT IFNULL(MAX(row_index), -1) FROM rows WHERE sheet_id = ? AND user_id = ?')
    .pluck().get(sheetId, userId) as number;
  return pending || top > e.watermark_row_index ? 'working' : 'done';
}

// A run on the column now: 'paused' waits for a person, 'active' ends on its own.
type ColumnRun = 'paused' | 'active' | null;
export function columnRunNow(sheetId: string, userId: string, kind: 'ai' | 'http', column: string): ColumnRun {
  const row = (kind === 'ai'
    ? db.prepare(`SELECT MAX(status = 'paused') AS paused FROM ai_runs WHERE sheet_id = ? AND user_id = ?
        AND column_name = ? AND (status IN ('pending','running','paused') OR placeholder_work IS NOT NULL)`)
    : db.prepare(`SELECT MAX(status = 'paused') AS paused FROM http_runs WHERE sheet_id = ? AND user_id = ?
        AND master_column_name = ? AND (status IN ('pending','running','paused') OR placeholder_work IS NOT NULL)`))
    .get(sheetId, userId, column) as { paused: number | null };
  return row.paused === null ? null : row.paused ? 'paused' : 'active';
}

const pausedRun = (column: string): RunFail => ({ fail: 'conflict',
  message: `A run on "${column}" is paused. Resume or stop it, then use the setup again.` });

// Before a start: wait for an active run on the column, stop at a paused one.
function blocked(now: ColumnRun, column: string): AgainStart | null {
  return now === 'paused' ? pausedRun(column) : now === 'active' ? { wait: true } : null;
}

function settled(
  kind: 'ai' | 'http', out: { ok: { runId: string } } | RunFail, now: () => ColumnRun, column: string,
): AgainStart {
  if ('ok' in out) return { ok: { kind, runId: out.ok.runId } };
  if (out.nothingToRun) return { done: DONE_ALREADY };
  // A run (auto-run, or one started by hand) began on it since the check: wait for it.
  return out.fail === 'conflict' ? blocked(now(), column) ?? out : out;
}

export async function startAgainStep(
  userId: string, sheetId: string, step: SetupStep,
  opts: { rowIndexes: number[] | null; allowSecrets: boolean; autoRun: boolean; refill: boolean },
): Promise<AgainStart> {
  const main = mainColumn(step);
  const scope = opts.rowIndexes ? { withinRows: opts.rowIndexes } : {};
  // A test whose rows were all deleted since leaves nothing to run.
  if (opts.rowIndexes?.length === 0 && step.kind !== 'clean' && step.kind !== 'formula') return { done: DONE_ALREADY };
  switch (step.kind) {
    case 'ai': {
      const now = () => columnRunNow(sheetId, userId, 'ai', main);
      const stop = blocked(now(), main);
      if (stop) return stop;
      return settled('ai', await rerunAiColumn(userId, { sheetId, baseColumnName: step.name, columnName: main,
        mode: 'empty', recheckKeptOut: true, ...scope }), now, main);
    }
    case 'http': {
      const now = () => columnRunNow(sheetId, userId, 'http', main);
      const stop = blocked(now(), main);
      if (stop) return stop;
      return settled('http', await rerunHttpColumn(userId, { sheetId, masterColumnName: main, mode: 'missing',
        recheckKeptOut: true, ...scope, forceAllowSecrets: opts.allowSecrets ? undefined : false }), now, main);
    }
    case 'enrichment': {
      const now = () => columnRunNow(sheetId, userId, 'http', main);
      const stop = blocked(now(), main);
      if (stop) return stop;
      const out = await rerunEnrichmentColumn(userId, sheetId, {
        column: main, estimateOnly: false, spendLimitUsd: null, rowGeneration: null,
        rows: opts.rowIndexes
          ? { mode: 'selected', status: 'not_enriched', test: null, rowIndexes: opts.rowIndexes }
          : { mode: 'all', status: 'not_enriched', test: null, rowIndexes: null },
      });
      if ('ok' in out && 'estimate' in out.ok) throw new Error('An enrichment start answered with an estimate.');
      return settled('http', out as { ok: { runId: string } } | RunFail, now, main);
    }
    case 'clean':
    case 'formula': {
      const rec = recordOf(sheetId, userId, step.kind, main);
      if (!rec) return { fail: 'not_found', message: `"${main}" isn't a ${step.kind} column anymore.` };
      if (!opts.refill && derivedFollows(sheetId, userId, step.kind, main)) {
        return { follow: { kind: step.kind, recordId: rec.id } };
      }
      // Its saved auto-run comes on with a run on every row; otherwise, or when a
      // person turned it off or paused it meanwhile (refill), it stays as it is.
      const autoRun = opts.autoRun && step.autoRun && !opts.refill ? true : undefined;
      if (step.kind === 'clean') {
        const r = rec as NonNullable<ReturnType<typeof cleanColumnFor>>;
        let options: unknown = {};
        try { options = JSON.parse(r.options); } catch { /* the cleaner's defaults */ }
        const out = await startCleanColumn(userId, sheetId, { source: r.source_column, cleaner: r.cleaner,
          column: main, options, autoRun });
        return 'fail' in out ? out : { ok: { kind: 'clean', recordId: out.ok.id } };
      }
      const r = rec as NonNullable<ReturnType<typeof formulaColumnFor>>;
      const out = await startFormulaColumn(userId, sheetId, { formula: r.formula, column: main,
        description: r.description, autoRun });
      return 'fail' in out ? out : { ok: { kind: 'formula', recordId: out.ok.id } };
    }
  }
}
