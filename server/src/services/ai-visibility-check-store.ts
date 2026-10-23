// The record of each "Check again" on an AI visibility table (migration 048,
// services/ai-visibility-check.ts): read, moved to its next stage, shown as
// the app, /api/v1 and MCP show it; when the answers it keeps were asked; and
// the stopped check the next one picks up.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { dayIn, type CheckNames } from '../lib/ai-visibility/check';

export type CheckStage = 'copying' | 'comparing' | 'asking' | 'done' | 'stopped';
export interface CheckRow {
  id: string; user_id: string; visibility_id: string; label: string; answers_at: string; stage: CheckStage;
  questions_copy_id: string | null; sites_copy_id: string | null;
  questions_copy_name: string; sites_copy_name: string | null; brands: string; named_by_column: string;
  change_column: string; runs: string; problems: string; run_floor: number; created_at: string;
}
export interface CheckRun { column: string; runId: string; rows: number }

const list = <T>(s: string): T[] => {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
};
export const runsOf = (c: CheckRow): CheckRun[] => list<CheckRun>(c.runs);
export const brandsOf = (c: CheckRow): string[] => list<string>(c.brands);

// The engine columns the check has asked (or found nothing to ask), by their
// runs' names now: a column renamed since is still the one it asked.
export function askedColumns(userId: string, c: CheckRow): Set<string> {
  const runs = runsOf(c);
  const ids = runs.filter(r => r.runId).map(r => r.runId);
  const named = db.prepare(`SELECT master_column_name FROM http_runs WHERE user_id = ?
    AND id IN (SELECT value FROM json_each(?))`).pluck().all(userId, JSON.stringify(ids)) as string[];
  return new Set([...named, ...runs.filter(r => !r.runId).map(r => r.column)]);
}

// When the engines were last asked anything: the newest run of theirs that asked a row.
export function lastAskedAt(userId: string, sheetId: string, engines: string[]): string | null {
  return (db.prepare(`SELECT MAX(created_at) FROM http_runs WHERE sheet_id = ? AND user_id = ? AND setup_only = 0
    AND processed_rows > 0 AND master_column_name IN (SELECT value FROM json_each(?))`)
    .pluck().get(sheetId, userId, JSON.stringify(engines)) as string | null) ?? null;
}

// The day most of the answers there now were asked (each row's newest answer
// per engine), where the asker is, and the newest of them: one new question
// asked yesterday doesn't date a sheet of answers from last month. Counted per
// run in SQL, so only the runs come back.
export function answersDay(
  userId: string, sheetId: string, engines: string[], timeZone: string | null,
): { day: string; at: string } | null {
  const runs = db.prepare(`SELECT created_at AS at, COUNT(*) AS n FROM (
      SELECT r.created_at, ROW_NUMBER() OVER (PARTITION BY r.master_column_name, res.row_index
        ORDER BY r.created_at DESC, r.rowid DESC) AS k
      FROM http_results res JOIN http_runs r ON r.id = res.run_id
      WHERE r.sheet_id = ? AND r.user_id = ? AND r.setup_only = 0
        AND r.master_column_name IN (SELECT value FROM json_each(?))
    ) WHERE k = 1 GROUP BY created_at`).all(sheetId, userId, JSON.stringify(engines)) as
    Array<{ at: string; n: number }>;
  const days = new Map<string, { n: number; at: string }>();
  for (const r of runs) {
    const day = dayIn(r.at, timeZone);
    const d = days.get(day) ?? { n: 0, at: r.at };
    days.set(day, { n: d.n + r.n, at: r.at > d.at ? r.at : d.at });
  }
  let best: { day: string; at: string; n: number } | null = null;
  for (const [day, d] of days) if (!best || d.n > best.n || (d.n === best.n && day > best.day)) best = { day, ...d };
  return best && { day: best.day, at: best.at };
}

export const loadCheck = (userId: string, id: string): CheckRow | undefined =>
  db.prepare('SELECT * FROM ai_visibility_checks WHERE id = ? AND user_id = ?').get(id, userId) as CheckRow | undefined;

// A check still between its first copy and its asking.
export const checkGoing = (userId: string, visibilityId: string): CheckRow | undefined => db.prepare(`SELECT *
  FROM ai_visibility_checks WHERE visibility_id = ? AND user_id = ? AND stage IN ('copying', 'comparing', 'asking')
  LIMIT 1`).get(visibilityId, userId) as CheckRow | undefined;

// The table's newest check, when it stopped with its questions copy still
// there, some engine not started and no engine asked since but by it: the
// next check picks it up instead of copying again.
export function stoppedToPickUp(userId: string, visibilityId: string, sheetId: string, engines: string[]):
  CheckRow | null {
  const c = db.prepare(`SELECT * FROM ai_visibility_checks WHERE visibility_id = ? AND user_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(visibilityId, userId) as CheckRow | undefined;
  if (!c || c.stage !== 'stopped' || !c.questions_copy_id) return null;
  if (!db.prepare('SELECT 1 FROM sheets WHERE id = ? AND user_id = ? AND trash_id IS NULL')
    .get(c.questions_copy_id, userId)) return null;
  const own = runsOf(c);
  const asked = askedColumns(userId, c);
  if (engines.every(e => asked.has(e))) return null;
  const since = db.prepare(`SELECT COUNT(*) FROM http_runs WHERE sheet_id = ? AND user_id = ? AND setup_only = 0
    AND processed_rows > 0 AND rowid > ? AND master_column_name IN (SELECT value FROM json_each(?))
    AND id NOT IN (SELECT value FROM json_each(?))`).pluck().get(sheetId, userId, c.run_floor,
    JSON.stringify(engines), JSON.stringify(own.map(r => r.runId).filter(Boolean))) as number;
  return since === 0 ? c : null;
}

export function insertCheck(
  userId: string, visibilityId: string, day: { day: string; at: string }, names: CheckNames, brands: string[],
): string {
  const id = uuidv4();
  db.prepare(`INSERT INTO ai_visibility_checks (id, user_id, visibility_id, label, answers_at, stage,
      questions_copy_name, sites_copy_name, brands, named_by_column, change_column, run_floor)
    VALUES (?, ?, ?, ?, ?, 'copying', ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(rowid), 0) FROM http_runs))`)
    .run(id, userId, visibilityId, day.day, day.at, names.questionsCopy, names.sitesCopy, JSON.stringify(brands),
      names.namedBy, names.change);
  return id;
}

export function updateCheck(userId: string, id: string, set: {
  stage?: CheckStage; questionsCopyId?: string; sitesCopyId?: string; addRun?: CheckRun; problems?: string[];
  freshProblems?: boolean; // picked up again: what stopped it before is over
}): void {
  db.transaction(() => {
    const now = loadCheck(userId, id);
    if (!now) return;
    const problems = [...(set.freshProblems ? [] : list<string>(now.problems)), ...(set.problems ?? [])];
    const runs = [...runsOf(now), ...(set.addRun ? [set.addRun] : [])];
    db.prepare(`UPDATE ai_visibility_checks SET stage = ?, questions_copy_id = ?, sites_copy_id = ?, runs = ?,
        problems = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
      .run(set.stage ?? now.stage, set.questionsCopyId ?? now.questions_copy_id,
        set.sitesCopyId ?? now.sites_copy_id, JSON.stringify(runs), JSON.stringify(problems), id, userId);
  }).immediate(); // read then write: deferred, a run's worker writing meanwhile makes it SQLITE_BUSY
}

export interface CheckView {
  id: string; label: string; stage: CheckStage; checkedAt: string;
  questionsCopySheetId: string | null; sitesCopySheetId: string | null;
  namedByColumn: string; changeColumn: string; runs: CheckRun[]; problems: string[];
}
export const checkView = (r: CheckRow): CheckView => ({
  id: r.id, label: r.label, stage: r.stage, checkedAt: r.created_at, questionsCopySheetId: r.questions_copy_id,
  sitesCopySheetId: r.sites_copy_id, namedByColumn: r.named_by_column, changeColumn: r.change_column,
  runs: runsOf(r), problems: list<string>(r.problems),
});

// The table's checks, newest first.
export const checksOf = (userId: string, visibilityId: string, limit = 5): CheckView[] =>
  (db.prepare(`SELECT * FROM ai_visibility_checks WHERE visibility_id = ? AND user_id = ?
    ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(visibilityId, userId, limit) as CheckRow[]).map(checkView);
