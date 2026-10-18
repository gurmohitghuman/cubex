// Seeding an enrichment run, in the background of its start and inside the
// sheet's busy window (services/run-seed.ts does the same for AI and HTTP
// runs): the ⏳ placeholder goes only into the rows the run takes
// (lib/enrich-seed.ts), a slice of rows at a time in storage order, and only
// then is the run queued. total_rows becomes the number seeded. A test run
// ("Run on 5 rows") takes the first matching rows in row order instead. A full
// run marks the rows its "Only run if" keeps out "⏭️ Condition not met" in its
// status column, unless that cell holds an earlier result.
import { db } from '../lib/db';
import { continueInBackground } from '../lib/sheet-busy';
import { PLACEHOLDER } from '../lib/placeholder-cells';
import { CONDITION_NOT_MET, isConditionNotMet, takesConditionMark } from '../lib/run-markers';
import { eachRowIdSlice, sheetRowIds } from '../lib/row-order';
import { jsonPath, parseRowData } from '../lib/sql-rows';
import { yieldToRequests } from '../lib/slices';
import { redactSecrets } from '../lib/redact';
import { clearRunPlaceholders } from '../lib/run-placeholders';
import { seedVerdict, type SeedPlan } from '../lib/enrich-seed';
import type { EnrichRunConfig } from '../lib/enrich-run-config';
import type { WaterfallRunConfig } from '../lib/waterfall/config';
import { enqueueHTTPRun } from '../queue';
import type { CompiledFilter } from '../lib/row-filter/sql';

// The out-of-date flag, selected next to a row's data when the run's rows depend on it.
const staleFlag = (c: CompiledFilter | null) => (c ? `${c.sql} IS 1` : '0');

export interface SeedJob {
  runId: string; sheetId: string; userId: string;
  columns: string[];                 // the run's columns (status + outputs) to seed
  plan: SeedPlan<EnrichRunConfig | WaterfallRunConfig>;   // a waterfall run is seeded the same way
  rowFilter: { clause: string; params: unknown[] };   // the saved filter ("filter" mode), as SQL
  targets: number[] | null;          // selected rows
  lastRow: number;                   // rows appended after the start aren't part of the run
  test: number | null;               // take only the first N matching rows
}

const TEST_PAGE = 500;

// The first `n` rows (row order) the run would take: a short scan in pages.
async function firstMatching(job: SeedJob, n: number): Promise<{ targets: number[]; missing: number }> {
  const inTargets = job.targets ? new Set(job.targets) : null;
  const stale = job.plan.stale ?? null;
  const page = db.prepare(`SELECT row_index, data, ${staleFlag(stale)} AS stale FROM rows
    WHERE sheet_id = ? AND user_id = ? AND row_index > ? AND row_index <= ?${job.rowFilter.clause}
    ORDER BY row_index LIMIT ${TEST_PAGE}`);
  const targets: number[] = [];
  let missing = 0;
  for (let after = Number.MIN_SAFE_INTEGER; targets.length < n;) {
    const rows = page.all(...(stale?.params ?? []), job.sheetId, job.userId, after, job.lastRow,
      ...job.rowFilter.params) as Array<{ row_index: number; data: string; stale: number }>;
    for (const r of rows) {
      // Rows past the test rows aren't part of the run: neither run nor skipped.
      if (targets.length >= n) break;
      if (inTargets && !inTargets.has(r.row_index)) continue;
      const v = seedVerdict(parseRowData(r.data), job.plan, r.stale === 1);
      if (v === 'missing') missing++;
      if (v === 'run') targets.push(r.row_index);
    }
    if (rows.length < TEST_PAGE) break;
    after = rows[rows.length - 1].row_index;
    await yieldToRequests();
  }
  return { targets, missing };
}

type Seeded = { seeded: number; missing: number; notMet: number };

async function seed(job: SeedJob, live: () => boolean): Promise<Seeded | null> {
  const paths = job.columns.map(jsonPath);
  // The status column (the run's first) of a row "Only run if" keeps out.
  const markPath = jsonPath(job.columns[0]);
  const mark = db.prepare(`UPDATE rows SET data = json_set(data, ?, '${CONDITION_NOT_MET}')
    WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?`);
  const set = db.prepare(`UPDATE rows SET data = json_set(data${paths.map(() => `, ?, '${PLACEHOLDER}'`).join('')})
    WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?`);
  const stale = job.plan.stale ?? null;
  const read = db.prepare(`SELECT rowid AS id, data, ${staleFlag(stale)} AS stale FROM rows
    WHERE rowid IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?${job.rowFilter.clause}`);
  let targets = job.targets, missing = 0;
  if (job.test !== null) ({ targets, missing } = await firstMatching(job, job.test));
  if (targets && targets.length === 0) return { seeded: 0, missing, notMet: 0 };
  const rowIds = await sheetRowIds(job.sheetId, job.userId, targets ? { targets } : { upTo: job.lastRow });
  let seeded = 0, notMet = 0, stopped = false;
  await eachRowIdSlice(rowIds, ids => {
    if (!live()) { stopped = true; return false; }
    const take: number[] = [], keptOut: number[] = [];
    const found = read.all(...(stale?.params ?? []), ids, job.sheetId, job.userId, ...job.rowFilter.params) as
      Array<{ id: number; data: string; stale: number }>;
    for (const r of found) {
      const data = parseRowData(r.data);
      const v = job.test !== null ? 'run' : seedVerdict(data, job.plan, r.stale === 1);
      if (v === 'run') take.push(r.id);
      else if (v === 'missing') missing++;
      else if (v === 'condition') {
        notMet++;
        // A row kept out already keeps its mark: no write.
        const was = data[job.columns[0]];
        if (takesConditionMark(was) && !isConditionNotMet(was)) keptOut.push(r.id);
      }
    }
    if (take.length) set.run(...paths, JSON.stringify(take), job.sheetId, job.userId);
    if (keptOut.length) mark.run(markPath, JSON.stringify(keptOut), job.sheetId, job.userId);
    seeded += take.length;
  });
  return stopped ? null : { seeded, missing, notMet };
}

export function seedEnrichmentThenEnqueue(job: SeedJob): void {
  continueInBackground(job.sheetId, 'starting a run', async () => {
    const live = (): boolean => {
      const r = db.prepare('SELECT status, placeholder_work FROM http_runs WHERE id = ?').get(job.runId) as
        { status: string; placeholder_work: string | null } | undefined;
      return r?.status === 'pending' && r.placeholder_work === 'seeding';
    };
    try {
      const done = await seed(job, live);
      if (!done) return;
      // Fully seeded: drop the mark in the same transaction as the check, so a
      // restart from here resumes the run like any other pending one. A run
      // that took no rows is simply done.
      const ready = db.transaction(() => {
        const r = db.prepare(`UPDATE http_runs SET placeholder_work = NULL, total_rows = ?, skipped_rows = ?,
          condition_skipped_rows = ?,
          status = CASE WHEN ? = 0 THEN 'completed' ELSE status END, updated_at = datetime('now')
          WHERE id = ? AND status = 'pending' AND placeholder_work = 'seeding'`)
          .run(done.seeded, done.missing, done.notMet, done.seeded, job.runId);
        db.prepare('UPDATE sheets SET data_version = data_version + 1 WHERE id = ? AND user_id = ?')
          .run(job.sheetId, job.userId);
        return r.changes > 0;
      })();
      if (ready && done.seeded > 0) await enqueueHTTPRun(job.runId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      db.prepare(`UPDATE http_runs SET status = 'failed', error_message = ?, placeholder_work = 'clearing',
          updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'`)
        .run(redactSecrets(`The run could not start: ${reason}`).slice(0, 500), job.runId);
      await clearRunPlaceholders('http', job.runId);
      console.error(`Starting enrichment run ${job.runId} failed:`, redactSecrets(reason));
    }
  });
}
