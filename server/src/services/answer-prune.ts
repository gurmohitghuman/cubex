// Pruning stored answers: a treg answer's `raw` part (the provider's own
// Over 200 lines: the prune write, and the pass that finds what to prune with its column cache.
// data, up to ENRICH_STORED_RAW_MAX_BYTES) is removed and `$prunedAt` notes
// when; `output` and `_treg` stay, so cells, the answer panel and "+ Column"
// keep working (lib/answer-paths.ts refuses paths into `raw` after a prune).
// Only answers shaped like treg's routed answers ({output, _treg, raw}) are
// touched: a single tool's answer is the provider's whole answer, kept as is.
//
// When a row is enriched again, its older answers are pruned: once a run has
// ended (migration 018's answers_pruned = 0 marks the pass still to do, so a
// restart finishes it), the API process walks the run's answered rows and
// prunes the answers older runs of the same column hold at those rows. The
// newest answer is the one the panel and "+ Column" read.
import { db } from '../lib/db';
import { ANSWER_PRUNE_SWEEP_MS } from '../lib/constants';
import { yieldToRequests } from '../lib/slices';
import { walkRunResults, type WalkPos } from './run-results-walk';

const PRUNE = `UPDATE http_results
  SET response_data = json_set(json_remove(response_data, '$.raw'), '$."$prunedAt"', ?)
  WHERE rowid IN (SELECT value FROM json_each(?)) AND +user_id = ?
    AND json_type(response_data, '$.raw') IS NOT NULL AND json_type(response_data, '$._treg') IS NOT NULL`;

// Prunes these results (by rowid) where they still hold a raw part. Call inside a transaction.
export function pruneAnswers(userId: string, rowids: number[], at = new Date().toISOString()): number {
  if (rowids.length === 0) return 0;
  return db.prepare(PRUNE).run(at, JSON.stringify(rowids), userId).changes;
}

interface DueRun {
  id: string; user_id: string; sheet_id: string; master: string | null; created_at: string; rid: number;
  cursor: number; generation: number | null; enrichment: number;
}
// A run of the column, with its results' row_index range ("open": not ended
// yet, so its range can still grow). The cache only narrows which runs a
// slice asks; whether an answer is replaced is checked against the runs as
// they are at that moment (supersededNow).
interface ColumnRun {
  id: string; created_at: string; rid: number; lo: number | null; hi: number | null; open: boolean;
}
interface Column { generation: number | null; runs: ColumnRun[]; maxRid: number; usedAt: number }

// Due runs one round takes; each is one pass, with a yield after it.
const DUE_PER_ROUND = 200;
// A pass that keeps failing (a bug, not a busy sheet) is given up after this many tries: pruning only saves space.
const PASS_ATTEMPTS = 5;
const failures = new Map<string, number>();
// Columns' runs kept between rounds (a column can hold tens of thousands):
// each round reads only the runs added since, and all again after a sort.
const columns = new Map<string, Column>();
const COLUMN_IDLE_MS = 10 * 60 * 1000;

const markDone = (run: { id: string; user_id: string }) =>
  db.prepare('UPDATE http_runs SET answers_pruned = 1 WHERE id = ? AND user_id = ?').run(run.id, run.user_id);

const generationOf = (sheetId: string, userId: string) =>
  (db.prepare('SELECT row_generation FROM sheets WHERE id = ? AND user_id = ?').pluck().get(sheetId, userId) as
    number | undefined) ?? null;

const RANGE = `(SELECT MIN(row_index) FROM http_results WHERE run_id = r.id) AS lo,
  (SELECT MAX(row_index) FROM http_results WHERE run_id = r.id) AS hi,
  r.status NOT IN ('completed', 'failed', 'cancelled') AS open`;

// The column's runs above its last rowid, with their ranges, a page at a
// time (a first load of a column with 100,000 runs would hold the server).
const ADD_PAGE = 2_000;
async function addRuns(col: Column, sheetId: string, userId: string, master: string): Promise<void> {
  const page = db.prepare(`SELECT r.id, r.created_at, r.rowid AS rid, ${RANGE} FROM http_runs r
    WHERE r.sheet_id = ? AND r.master_column_name = ? AND r.user_id = ? AND r.rowid > ? ORDER BY r.rowid LIMIT ?`);
  for (;;) {
    const runs = page.all(sheetId, master, userId, col.maxRid, ADD_PAGE) as
      Array<Omit<ColumnRun, 'open'> & { open: number }>;
    for (const r of runs) col.runs.push({ ...r, open: !!r.open });
    col.maxRid = runs.reduce((m, r) => Math.max(m, r.rid), col.maxRid);
    if (runs.length < ADD_PAGE) return;
    await yieldToRequests();
  }
}

// A rename or delete moves runs between columns: the sheet's cached columns
// are read again (supersededNow keeps any prune right meanwhile).
export function forgetPruneColumns(sheetId: string): void {
  for (const key of columns.keys()) if (key.startsWith(`${sheetId}\0`)) columns.delete(key);
}

// The column as it is now: new runs added, open runs' ranges read again.
async function columnOf(sheetId: string, userId: string, master: string): Promise<Column> {
  const key = `${sheetId}\0${master}`;
  const generation = generationOf(sheetId, userId);
  let col = columns.get(key);
  if (!col || col.generation !== generation) {
    col = { generation, runs: [], maxRid: 0, usedAt: 0 };
    columns.set(key, col);
  }
  const reread = db.prepare(`SELECT ${RANGE} FROM http_runs r WHERE r.id = ? AND r.user_id = ?`);
  for (const r of col.runs) {
    if (!r.open) continue;
    const now = reread.get(r.id, userId) as { lo: number | null; hi: number | null; open: number } | undefined;
    if (now) Object.assign(r, { lo: now.lo, hi: now.hi, open: !!now.open });
  }
  await addRuns(col, sheetId, userId, master);
  col.usedAt = Date.now();
  return col;
}

// The column's runs older than `run` that hold results.
function olderThan(run: DueRun, col: Column): ColumnRun[] {
  return col.runs.filter(o => o.lo !== null && o.id !== run.id
    && (o.created_at < run.created_at || (o.created_at === run.created_at && o.rid < run.rid)));
}

// Of these older runs, the ones whose answers `run` replaces now: still runs
// of the same column (a rename or delete moves them), and none of their
// output columns left behind. An output column reads the runs linked to it
// (answer-runs.ts), so a run that dropped one doesn't replace an older run's
// answer for it.
function supersededNow(run: DueRun, candidates: ColumnRun[]): ColumnRun[] {
  if (candidates.length === 0) return [];
  const ids = JSON.stringify([run.id, ...candidates.map(c => c.id)]);
  const masters = new Map((db.prepare(`SELECT id, master_column_name AS m FROM http_runs
    WHERE id IN (SELECT value FROM json_each(?)) AND user_id = ?`).all(ids, run.user_id) as
    Array<{ id: string; m: string | null }>).map(r => [r.id, r.m]));
  const links = new Map<string, Set<string>>();
  for (const l of db.prepare(`SELECT run_id, extracted_column_name AS c FROM http_column_associations
    WHERE run_id IN (SELECT value FROM json_each(?)) AND +user_id = ?`).all(ids, run.user_id) as
    Array<{ run_id: string; c: string | null }>) {
    if (!links.has(l.run_id)) links.set(l.run_id, new Set());
    if (l.c) links.get(l.run_id)!.add(l.c);
  }
  const master = masters.get(run.id);
  const mine = links.get(run.id) ?? new Set<string>();
  if (!master) return [];
  return candidates.filter(c => masters.get(c.id) === master && [...(links.get(c.id) ?? [])].every(x => mine.has(x)));
}

async function pruneSuperseded(run: DueRun, col: Column): Promise<void> {
  const older = olderThan(run, col);
  if (older.length === 0) { markDone(run); return; }
  const atRows = db.prepare(`SELECT rowid FROM http_results WHERE run_id = ? AND row_index BETWEEN ? AND ?
    AND +row_index IN (SELECT value FROM json_each(?)) AND +user_id = ?`);
  const save = db.prepare(`UPDATE http_runs SET prune_cursor = ?, prune_generation = ?
    WHERE id = ? AND user_id = ? AND answers_pruned = 0`);
  const outcome = await walkRunResults({
    runId: run.id, sheetId: run.sheet_id, userId: run.user_id, answered: true,
    from: { cursor: run.cursor, generation: run.generation },
    step: (slice, to: WalkPos) => {
      const lo = slice.indexes[0];
      const hi = slice.indexes[slice.indexes.length - 1];
      const at = JSON.stringify(slice.indexes);
      const rowids: number[] = [];
      const overlapping = older.filter(o => (o.hi as number) >= lo && (o.lo as number) <= hi);
      for (const o of supersededNow(run, overlapping)) {
        rowids.push(...(atRows.pluck().all(o.id, lo, hi, at, run.user_id) as number[]));
      }
      db.transaction(() => {
        pruneAnswers(run.user_id, rowids);
        save.run(to.cursor, to.generation, run.id, run.user_id);
      }).immediate();
    },
  });
  if (outcome === 'done') markDone(run);
}

let sweeping = false;
// Rounds take due runs in rowid order from where the last one stopped, so
// runs on a sheet that stays busy (a long sort) never hold back the rest.
let dueAfter = 0;

// One round: ended runs whose pass is still to do (a busy sheet's wait for
// the next round). Yields after each run, so the server keeps answering.
export async function pruneSupersededAnswers(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const due = db.prepare(`SELECT id, user_id, sheet_id, master_column_name AS master, created_at, rowid AS rid,
        prune_cursor AS cursor, prune_generation AS generation,
        json_type(config, '$.enrichment') IS NOT NULL AS enrichment
      FROM http_runs WHERE answers_pruned = 0 AND status IN ('completed', 'failed', 'cancelled') AND rowid > ?
      ORDER BY rowid LIMIT ?`).all(dueAfter, DUE_PER_ROUND) as DueRun[];
    dueAfter = due.length === DUE_PER_ROUND ? due[due.length - 1].rid : 0;
    for (const [key, col] of columns) if (Date.now() - col.usedAt > COLUMN_IDLE_MS) columns.delete(key);
    for (const run of due) {
      try {
        if (!run.enrichment || !run.master) { markDone(run); continue; }
        await pruneSuperseded(run, await columnOf(run.sheet_id, run.user_id, run.master));
        failures.delete(run.id);
      } catch (err) {
        const n = (failures.get(run.id) ?? 0) + 1;
        failures.set(run.id, n);
        if (n >= PASS_ATTEMPTS) {
          failures.delete(run.id);
          markDone(run);
          console.error(`Pruning older answers for run ${run.id} failed ${n} times; leaving them as they are:`, err);
        } else {
          console.error(`Pruning older answers for run ${run.id} failed, retrying next round:`, err);
        }
      }
      await yieldToRequests();
    }
  } finally {
    sweeping = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startAnswerPruneLoop(): void {
  if (timer) return;
  const round = () => void pruneSupersededAnswers()
    .catch(err => console.error('Pruning older answers failed this round:', err));
  round();
  timer = setInterval(round, ANSWER_PRUNE_SWEEP_MS);
  timer.unref?.();
}
