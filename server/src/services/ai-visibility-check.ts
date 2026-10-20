// "Check again" on an AI visibility table: one implementation for the app's
// guide, /api/v1 and MCP. Answers move slowly and vary from one ask to the
// next, so a later check compares with the answers kept: the questions sheet
// and its cited sites are copied, values only, into dated sheets ("Questions
// 2026-10-01", services/sheet-copy.ts); the questions sheet gets "Named by on
// <date>" (a lookup of that day's Named by, by question) and "Change since
// <date>" (a formula: Up 2, Down 1, Same, New); then every engine asks every
// question again, fresh. The estimate (a pure read) comes first. Each stage is
// journaled (ai_visibility_checks, migration 048) and each run recorded as it
// starts: a restart finishes the free part and never asks on its own, and a
// check that stopped (a restart, a refusal, the daily limit) is picked up by
// the next one, which keeps its copies and asks only the engines it didn't start.
// Over 200 lines: the plan and each stage of one journaled check, read in order.
import { db } from '../lib/db';
import { countRows, getSheetColumns } from '../lib/sql-helpers';
import { sheetNameTaken } from '../lib/sheet-crud-helpers';
import { checkNames, daysSince, type CheckNames } from '../lib/ai-visibility/check';
import { changeFormula } from '../lib/ai-visibility/formulas';
import {
  AI_VISIBILITY_CHECK_SOON_DAYS, FORMULA_MAX_CHARS, HEAVY_JOB_RETRY_MS, MAX_COLUMNS_PER_SHEET,
} from '../lib/constants';
import { NAMED_BY_COLUMN, QUESTION_COLUMN } from '../lib/ai-visibility/engines';
import { copySheetValues } from './sheet-copy';
import { newestColumnRun } from './enrich-column';
import { sheetFree } from './ai-visibility-columns';
import { addComparison, answerColumnsOf, competitorsOf } from './ai-visibility-check-columns';
import {
  aiVisibilityRecord, engineColumnsOf, estimateAsk, startAsk, type AiVisibilityRecord, type AskEstimate,
} from './ai-visibility-run';
import {
  answersDay, askedColumns, checkGoing, checkView, insertCheck, loadCheck, runsOf, stoppedToPickUp, updateCheck,
  type CheckRow, type CheckView,
} from './ai-visibility-check-store';
import type { RunFail } from './run-shared';

// picksUp: the stopped check this one goes on with (its copies and columns
// kept); engines: those it asks.
export interface CheckPlan {
  label: string; askedAt: string; days: number; soon: boolean; questions: number; engines: string[];
  names: CheckNames; picksUp: string | null;
}

const bad = (message: string): RunFail => ({ fail: 'bad_request', message });
const PICK_UP = 'Check again picks up here: it keeps these answers and asks only the engines this check '
  + 'didn\'t start.';

// What a check would do now, or why it can't (a pure read). timeZone: the
// asker's, for the day in the names (null: UTC). fresh: a new check even when
// a stopped one could be picked up (one of its engines can't start, say).
export interface CheckOpts { timeZone?: string | null; fresh?: boolean }
export function checkPlan(userId: string, rec: AiVisibilityRecord, opts: CheckOpts = {}): CheckPlan | RunFail {
  const q = rec.questions_sheet_id;
  const engines = engineColumnsOf(userId, q);
  if (engines.length === 0) return bad('This table has no engine columns left to ask.');
  const columns = getSheetColumns(q, userId);
  if (!columns.includes(QUESTION_COLUMN) || !columns.includes(NAMED_BY_COLUMN)) {
    return bad(`A check compares "${NAMED_BY_COLUMN}" question by question, and this table no longer has both `
      + `"${QUESTION_COLUMN}" and "${NAMED_BY_COLUMN}".`);
  }
  if (checkGoing(userId, rec.id)) return { fail: 'conflict', message: 'A check of this table is still going.' };
  const running = engines.find(c => newestColumnRun(q, userId, c)?.active);
  if (running) return { fail: 'conflict', message: `${running} is still being asked: check again once it's done.` };
  const questions = countRows(q, userId);
  const plan = (day: string, at: string, names: CheckNames, toAsk: string[], picksUp: string | null) => {
    const days = daysSince(at);
    return { label: day, askedAt: at, days, soon: days < AI_VISIBILITY_CHECK_SOON_DAYS, questions, engines: toAsk,
      names, picksUp };
  };
  const stopped = opts.fresh ? null : stoppedToPickUp(userId, rec.id, q, engines);
  if (stopped) {
    const asked = askedColumns(userId, stopped);
    return plan(stopped.label, stopped.answers_at, {
      questionsCopy: stopped.questions_copy_name, sitesCopy: stopped.sites_copy_name,
      namedBy: stopped.named_by_column, change: stopped.change_column,
    }, engines.filter(e => !asked.has(e)), stopped.id);
  }
  const kept = answersDay(userId, q, engines, opts.timeZone ?? null);
  if (!kept) return bad('Ask the engines first: there are no answers to keep yet.');
  if (columns.length + 2 > MAX_COLUMNS_PER_SHEET) {
    return bad(`A check adds 2 columns, and this sheet has ${columns.length} of the ${MAX_COLUMNS_PER_SHEET} `
      + 'it may have.');
  }
  const nameOf = (id: string | null) => (id ? db.prepare(`SELECT name FROM sheets WHERE id = ? AND user_id = ?
    AND trash_id IS NULL`).pluck().get(id, userId) as string | undefined : undefined) ?? null;
  const names = checkNames(kept.day, { questions: nameOf(q)!, sites: nameOf(rec.sites_sheet_id) },
    n => sheetNameTaken(rec.table_id, userId, n), n => columns.some(c => c.toLowerCase() === n.toLowerCase()));
  const formula = changeFormula(answerColumnsOf(userId, q), names.namedBy, [rec.brand, ...competitorsOf(rec)]);
  if (formula.length > FORMULA_MAX_CHARS) {
    return bad('The change column\'s formula would be too long: look for fewer brands, or shorten the answer '
      + 'columns\' names.');
  }
  return plan(kept.day, kept.at, names, engines, null);
}

export async function estimateCheck(
  userId: string, rec: AiVisibilityRecord, opts: CheckOpts = {},
): Promise<{ plan: CheckPlan; estimate: AskEstimate } | RunFail> {
  const plan = checkPlan(userId, rec, opts);
  if ('fail' in plan) return plan;
  const skip = engineColumnsOf(userId, rec.questions_sheet_id).filter(c => !plan.engines.includes(c));
  return { plan, estimate: await estimateAsk(userId, rec, true, skip) };
}

// refuse: an agent's check before each engine starts (its spend cap and run-start window).
export async function startCheck(
  userId: string, rec: AiVisibilityRecord, opts: CheckOpts & { refuse?: () => string | null } = {},
): Promise<{ ok: CheckView } | RunFail> {
  const plan = checkPlan(userId, rec, opts);
  if ('fail' in plan) return plan;
  // In the same turn as the plan's checks: a second check can't slip in between.
  let id: string;
  if (plan.picksUp) {
    id = plan.picksUp;
    // Back to its copies when it asked nothing yet (a copy may be missing), else to its columns.
    const asked = runsOf(loadCheck(userId, id)!).length > 0;
    updateCheck(userId, id, { stage: asked ? 'comparing' : 'copying', freshProblems: true });
  } else {
    id = insertCheck(userId, rec.id, { day: plan.label, at: plan.askedAt }, plan.names,
      [rec.brand, ...competitorsOf(rec)]);
  }
  await continueCheck(userId, id, { ask: true, refuse: opts.refuse });
  return { ok: checkView(loadCheck(userId, id)!) };
}

// A copy, by the name the check chose. Made before a restart, it's there by
// that name, finishing on its own: the check waits for it, and takes it only
// when its History says it's a whole copy of this sheet.
async function copyInto(userId: string, tableId: string, sourceId: string, name: string): Promise<string | string[]> {
  for (let tries = 0; ; tries++) {
    await sheetFree(sourceId);
    const out = await copySheetValues(userId, sourceId, { name });
    if ('ok' in out) return out.ok.sheet.id;
    if (out.fail === 'conflict') {
      const made = db.prepare(`SELECT id FROM sheets WHERE table_id = ? AND user_id = ? AND name = ?
        AND trash_id IS NULL`).pluck().get(tableId, userId, name) as string | undefined;
      if (made) {
        while (db.prepare('SELECT 1 FROM sheet_copy_jobs WHERE sheet_id = ? AND user_id = ?').get(made, userId)) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        const logged = db.prepare(`SELECT detail FROM sheet_changes WHERE sheet_id = ? AND user_id = ?
          AND action = 'sheet_copied' ORDER BY id LIMIT 1`).pluck().get(made, userId) as string | undefined;
        const detail = logged ? JSON.parse(logged) as { from_sheet_id?: string; stopped?: string } : null;
        if (detail?.from_sheet_id === sourceId && !detail.stopped) return made;
        return [`A sheet named "${name}" is in the way: rename it, then check again.`];
      }
    }
    if (out.fail !== 'busy' || tries >= 3) return [`"${name}" wasn't made: ${out.message}`];
    await new Promise(resolve => setTimeout(resolve, HEAVY_JOB_RETRY_MS));
  }
}

async function copyStage(userId: string, rec: AiVisibilityRecord, c: CheckRow): Promise<boolean> {
  const q = c.questions_copy_id ?? await copyInto(userId, rec.table_id, rec.questions_sheet_id, c.questions_copy_name);
  if (Array.isArray(q)) { updateCheck(userId, c.id, { stage: 'stopped', problems: q }); return false; }
  updateCheck(userId, c.id, { questionsCopyId: q });
  if (rec.sites_sheet_id && c.sites_copy_name && !c.sites_copy_id) {
    const s = await copyInto(userId, rec.table_id, rec.sites_sheet_id, c.sites_copy_name);
    updateCheck(userId, c.id, Array.isArray(s) ? { problems: s } : { sitesCopyId: s });
  }
  updateCheck(userId, c.id, { stage: 'comparing' });
  return true;
}

// Asks the engines the check hasn't started, each recorded as it starts. Done
// once every engine is asked; else stopped, for the next check to pick up.
// An engine with nothing to ask (an "Only run if" rule keeps every row out) is done for the check.
async function askStage(userId: string, rec: AiVisibilityRecord, c: CheckRow, refuse?: () => string | null) {
  const started = await startAsk(userId, rec, true, refuse,
    { skip: [...askedColumns(userId, c)], onStarted: s => updateCheck(userId, c.id, { addRun: s }) });
  const problems = 'fail' in started ? [started.message] : started.problems;
  if (!('fail' in started)) {
    for (const column of started.nothing) updateCheck(userId, c.id, { addRun: { column, runId: '', rows: 0 } });
  }
  const now = askedColumns(userId, loadCheck(userId, c.id)!);
  const all = engineColumnsOf(userId, rec.questions_sheet_id).every(e => now.has(e));
  updateCheck(userId, c.id, all ? { stage: 'done', problems } : { stage: 'stopped', problems: [...problems, PICK_UP] });
}

// Takes the check from its stage to the end. ask: false at boot (the free part only).
async function continueCheck(
  userId: string, id: string, opts: { ask: boolean; refuse?: () => string | null },
): Promise<void> {
  let c = loadCheck(userId, id)!;
  const rec = aiVisibilityRecord(userId, c.visibility_id);
  if (!rec) { updateCheck(userId, id, { stage: 'stopped', problems: ['The table is no longer there.'] }); return; }
  try {
    if (c.stage === 'copying' && !(await copyStage(userId, rec, c))) return;
    c = loadCheck(userId, id)!;
    if (c.stage === 'comparing') {
      if (!c.questions_copy_id) {
        updateCheck(userId, id, { stage: 'stopped', problems: ['The copy of the questions is gone.'] });
        return;
      }
      const problems = await addComparison(userId, rec, c as CheckRow & { questions_copy_id: string });
      updateCheck(userId, id, opts.ask ? { stage: 'asking', problems } : {
        stage: 'stopped', problems: [...problems, `Cubex restarted before the engines were asked again. ${PICK_UP}`],
      });
      c = loadCheck(userId, id)!;
    }
    if (c.stage === 'asking' && opts.ask) await askStage(userId, rec, c, opts.refuse);
  } catch (error) {
    console.error(`Checking AI visibility table ${rec.id} again stopped:`, error);
    updateCheck(userId, id, { stage: 'stopped', problems: [`The check stopped: ${(error as Error).message}`] });
  }
}

// At boot, once lookups and formulas can fill: a check a restart cut short
// finishes its free part (copies, comparison columns), then stops; one cut
// short while asking stops (the runs it started go on by themselves). Either
// way the next check picks it up.
export function resumeAiVisibilityChecks(): void {
  const going = db.prepare(`SELECT id, user_id, stage FROM ai_visibility_checks
    WHERE stage IN ('copying', 'comparing', 'asking')`).all() as Array<{ id: string; user_id: string; stage: string }>;
  for (const c of going) {
    if (c.stage === 'asking') {
      updateCheck(c.user_id, c.id, { stage: 'stopped',
        problems: [`Cubex restarted while the engines were being asked. ${PICK_UP}`] });
      continue;
    }
    continueCheck(c.user_id, c.id, { ask: false })
      .catch(err => console.error(`Finishing AI visibility check ${c.id} failed:`, err));
  }
}
