// Over 200 lines: one start transaction re-checking everything a tick read, which only holds together.
// Starting an auto-run run: the column's newest run again, on the rows the
// pick chose (services/autorun-pick.ts). An enrichment is rebuilt from its
// recalled setup against treg's catalog as it is now (a retired tool pauses
// auto-run instead of running), with auto-run's own "Only run if" and a run
// limit of what is left of the column's daily cap. An HTTP column clones the
// newest run's config and its saved-key policy (allow_secrets): auto-run
// never gets more than that run had.
//
// The start is ONE immediate transaction inside the sheet's busy window: it
// re-checks every row (still not run, inputs there), inserts the run, puts ⏳
// in the rows it takes, empties their queue entries and moves the watermark.
// The rows are few (AUTORUN_MAX_ROWS), so no background seeding is needed.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { utcDay } from '../lib/clock';
import { PLACEHOLDER } from '../lib/placeholder-cells';
import { jsonPath, parseRowData } from '../lib/sql-rows';
import { candidateVerdict, type CandidatePlan } from '../lib/autorun-rules';
import { isEnrichmentConfig, listOf } from '../lib/enrich-run-config';
import { recallChoices, rerunInput } from '../lib/enrich-run-recall';
import type { HTTPAPIConfig } from '../lib/http-request-template';
import { clearRunPlaceholders } from '../lib/run-placeholders';
import { redactSecrets } from '../lib/redact';
import { asRunStart } from './run-seed';
import { getTool } from './enrich-catalog';
import { buildEnrichmentConfig } from './enrich-run-build';
import { MAX_COLUMNS_PER_SHEET } from '../lib/constants';
import { appendColumnsToOrder, getSheetColumns, verifySheetOwnership } from '../lib/sql-helpers';
import {
  columnOutputs, columnRunActive, loadEntry, pauseEntry, type AutorunEntry, type ColumnRunRow,
} from './autorun-entry';
import { requeueUnfinished } from './autorun-stop';
import { autorunListDest } from './autorun-list';
import { destMoved } from './enrich-list-dest';
import type { Picked } from './autorun-pick';
import { enqueueHTTPRerun } from '../queue';
import { isWaterfallConfig } from '../lib/waterfall/config';
import { prepareWaterfallAutorun } from './waterfall-autorun';
import { lookupStepsMoved } from './waterfall-build-lookup';

// dest: a list job's destination sheet and the columns it still needs there.
export interface PreparedRun {
  config: HTTPAPIConfig; allowSecrets: number; outputs: string[];
  dest: { destSheetId: string; newColumns: string[] } | null;
}
// repriced: the newest run was billed by the team's own key and treg prices
// the tool now; the room auto-run read had no dollar figure, so the tick reads
// it again at these prices and prepares once more with that run limit.
// retry: not now (a list job's destination is busy); the next tick tries again.
export type Prepared =
  | { ok: PreparedRun } | { pause: { reason: string; message: string } } | { repriced: HTTPAPIConfig }
  | { retry: true };

export async function prepareAutorunRun(
  e: AutorunEntry, newest: ColumnRunRow, config: HTTPAPIConfig, plan: CandidatePlan,
  rows: number, runLimitUsd: number | null,
): Promise<Prepared> {
  // A waterfall batch is rebuilt from the column's choices, its saved-key policy copied.
  if (isWaterfallConfig(config)) {
    const w = await prepareWaterfallAutorun(e, config, rows, runLimitUsd);
    if ('pause' in w) return w;
    return { ok: { config: w.ok.config, allowSecrets: newest.allow_secrets ?? 0, outputs: w.ok.outputs, dest: null } };
  }
  if (!isEnrichmentConfig(config)) {
    const outputs = columnOutputs(e.sheet_id, e.user_id, e.status_column);
    // Its run keeps auto-run's rule, so the column's newest run says how rows were picked.
    const { runIf: _old, ...rest } = config;
    const own = e.run_if ? { ...rest, runIf: e.run_if } : rest;
    return { ok: { config: own, allowSecrets: newest.allow_secrets ?? 1, outputs, dest: null } };
  }
  const tool = await getTool(config.enrichment.toolId);
  if (!('ok' in tool)) {
    const retired = tool.fail === 'not_found' || tool.fail === 'hidden';
    return retired
      ? { pause: { reason: 'retired', message: `${tool.message} Pick a replacement with Edit enrichment.` } }
      : { pause: { reason: 'unreachable', message: "Can't reach treg's catalog. Auto-run tries again soon." } };
  }
  const choices = { ...recallChoices(config, e.status_column), conditions: plan.where, runIf: e.run_if };
  const input = rerunInput(choices, { mode: 'selected', status: 'any', test: null, rowIndexes: null }, runLimitUsd);
  const built = await buildEnrichmentConfig(input, plan.columns, rows);
  if ('fail' in built) return { pause: { reason: 'setup', message: built.message } };
  if (e.run_if) built.ok.runIf = e.run_if;
  // Turned on while the team's own key billed the tool (no dollar cap), and treg prices it now.
  if (built.ok.enrichment.maxCostPerRowUsd !== null) {
    if (e.daily_cap_micro === null) {
      return { pause: { reason: 'priced', message: "treg prices this tool now. Set auto-run's daily cap to go on." } };
    }
    if (config.enrichment.maxCostPerRowUsd === null && runLimitUsd === null) return { repriced: built.ok };
  }
  const dest = autorunListDest(e, input.list, built.ok, plan.columns);
  if (!('ok' in dest)) return dest;
  return {
    ok: { config: built.ok, allowSecrets: 0, outputs: built.ok.responseMapping.map(m => m.columnName), dest: dest.ok },
  };
}

export type StartOutcome =
  | { started: { runId: string; rows: number } }
  | { none: true }       // every picked row was decided otherwise on the re-check
  | { retry: true }      // the sheet changed under the pick: the next sweep looks again
  | { full: true };      // its columns would pass the column cap

export async function startAutorunRun(
  e: AutorunEntry, plan: CandidatePlan, picked: Picked, prep: PreparedRun,
): Promise<StartOutcome> {
  const runId = uuidv4();
  let targets: number[] = [];
  const outcome = await asRunStart(e.sheet_id, async (): Promise<StartOutcome> => {
    let out: StartOutcome = { retry: true };
    db.transaction(() => {
      const cur = loadEntry(e.id);
      const sheet = db.prepare('SELECT row_generation AS g, data_version AS v FROM sheets WHERE id = ? AND user_id = ?')
        .get(e.sheet_id, e.user_id) as { g: number; v: number } | undefined;
      // Unchanged since the tick read it: same fence, same generation, and no
      // delete, sort, replace or rename since (they set rescan; the tick cleared it).
      if (!cur || !cur.enabled || cur.paused_reason || !sheet || cur.row_generation_seen !== sheet.g
        || cur.row_generation_seen !== e.row_generation_seen || cur.rescan
        || cur.watermark_row_index !== e.watermark_row_index) return;
      if (columnRunActive(e.sheet_id, e.user_id, e.status_column)) return;
      // A column a waterfall lookup step reads, renamed since the prep: the next tick builds from the new names.
      if (isWaterfallConfig(prep.config) && lookupStepsMoved(prep.config, e.user_id)) return;
      // Its outputs are in the column registry (a CSV replace can drop them).
      const listed = new Set(getSheetColumns(e.sheet_id, e.user_id, false));
      if (!listed.has(e.status_column)) return;
      const unlisted = prep.outputs.filter(c => !listed.has(c));
      if (listed.size + unlisted.length > MAX_COLUMNS_PER_SHEET) { out = { full: true }; return; }
      // A list job's destination: still there, with room for its columns
      // (before the queue is touched, so a refusal here keeps its rows queued).
      const dest = prep.dest;
      const destHave = dest ? getSheetColumns(dest.destSheetId, e.user_id, false) : [];
      const destAdd = dest ? dest.newColumns.filter(c => !destHave.includes(c)) : [];
      if (dest && !verifySheetOwnership(dest.destSheetId, e.user_id)) {
        return;
      }
      // Busy (a column change rewrites the runs into it by page) or changed since the prep: next tick.
      const fills = dest ? listOf(prep.config) : null;
      if (dest && fills && destMoved(e.user_id, dest.destSheetId, '', fills, dest.newColumns)) return;
      if (destHave.length + destAdd.length > MAX_COLUMNS_PER_SHEET) { out = { full: true }; return; }
      const queued = new Map(picked.rows.map(r => [r.id, r.fromPending]));
      const found = db.prepare(`SELECT id, row_index, data FROM rows WHERE id IN (SELECT value FROM json_each(?))
        AND +sheet_id = ? AND +user_id = ?`).all(JSON.stringify([...queued.keys()]), e.sheet_id, e.user_id) as
        Array<{ id: string; row_index: number; data: string }>;
      // A row queued now (an input written since the pick) counts its ❌ as not run, as the queue does.
      const inQueue = new Set(db.prepare(`SELECT row_id FROM autorun_pending WHERE autorun_id = ?
        AND row_id IN (SELECT value FROM json_each(?))`).pluck().all(e.id, JSON.stringify([...queued.keys()])));
      const keep = found.filter(r =>
        candidateVerdict(parseRowData(r.data), plan, queued.get(r.id) === true || inQueue.has(r.id)) === 'take');
      // Every picked row was decided (a new row queued meanwhile too); the watermark passes the new rows looked at.
      db.prepare('DELETE FROM autorun_pending WHERE autorun_id = ? AND row_id IN (SELECT value FROM json_each(?))')
        .run(e.id, JSON.stringify(picked.rows.map(r => r.id)));
      db.prepare('UPDATE autorun_columns SET watermark_row_index = ?, data_version_seen = ? WHERE id = ?')
        .run(picked.watermark, sheet.v + (keep.length ? 1 : 0), e.id);
      if (keep.length === 0) { out = { none: true }; return; }

      if (dest) appendColumnsToOrder(dest.destSheetId, e.user_id, destAdd);
      if (unlisted.length) appendColumnsToOrder(e.sheet_id, e.user_id, unlisted);
      targets = keep.map(r => r.row_index).sort((a, b) => a - b);
      db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name,
          target_rows, allow_secrets, placeholder_work, autorun_id, autorun_day, dest_sheet_id)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, ?, ?, ?)`)
        .run(runId, e.sheet_id, e.user_id, JSON.stringify(prep.config), keep.length, e.status_column,
          JSON.stringify(targets), prep.allowSecrets, e.id, utcDay(), dest?.destSheetId ?? null);
      // Every output is linked to this run: clearing a stopped run's ⏳ finds its columns this way.
      const assoc = db.prepare(`INSERT INTO http_column_associations
          (id, sheet_id, user_id, master_column_name, extracted_column_name, run_id) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const name of prep.outputs) assoc.run(uuidv4(), e.sheet_id, e.user_id, e.status_column, name, runId);
      const paths = [e.status_column, ...prep.outputs].map(jsonPath);
      db.prepare(`UPDATE rows SET data = json_set(data${paths.map(() => ', ?, ?').join('')})
        WHERE id IN (SELECT value FROM json_each(?)) AND +sheet_id = ? AND +user_id = ?`)
        .run(...paths.flatMap(p => [p, PLACEHOLDER]), JSON.stringify(keep.map(r => r.id)), e.sheet_id, e.user_id);
      db.prepare('UPDATE sheets SET data_version = data_version + 1 WHERE id = ? AND user_id = ?')
        .run(e.sheet_id, e.user_id);
      out = { started: { runId, rows: keep.length } };
    }).immediate();
    return out;
  });
  if ('fail' in outcome) return { retry: true };
  if ('full' in outcome) {
    pauseEntry(e.id, 'setup', `Column limit reached (${MAX_COLUMNS_PER_SHEET} per sheet): its columns don't fit. `
      + 'Delete unused columns, then turn auto-run on again.');
  }
  if ('started' in outcome) {
    try {
      await enqueueHTTPRerun(runId, targets);
    } catch (error) {
      const reason = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 400);
      // Its rows wait in the queue, and auto-run tries again a few minutes on (a restart, a busy queue).
      db.transaction(() => {
        const failed = db.prepare(`UPDATE http_runs SET status = 'failed', error_message = ?,
            placeholder_work = 'clearing', updated_at = datetime('now') WHERE id = ? AND status = 'pending'`)
          .run(`The run could not start: ${reason}`, runId).changes > 0;
        if (!failed) return;   // someone cancelled it meanwhile
        // Nothing was sent: every row goes back in the queue, HTTP columns' too.
        requeueUnfinished(e.id, e.sheet_id, e.user_id, e.status_column, targets);
        pauseEntry(e.id, 'queue', 'It tries again in a few minutes.');
      }).immediate();
      await clearRunPlaceholders('http', runId);
    }
  }
  return outcome;
}
