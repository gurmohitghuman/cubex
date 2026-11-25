// Putting a test's results back on the sheet when it is applied (sheet-test-apply.ts, in its transaction, after
// the copy's setup is written there). For each AI, HTTP API, enrichment or waterfall column whose setup the test
// changed or added, a sample row's result goes back to its row when the column's newest setup in the copy made it
// (the row's newest result, not undone, came from a run set up as the column's newest run there: a rerun of some
// rows keeps the others' answers; it answered: a failed row keeps its value, for a run to fill) and from the input
// cells the row has (the stamp that run wrote equals the row's own under the new setup), so nothing goes back that
// the sheet's row would not have made. The cells go through
// the run writer under a run of their own on the sheet, kept from the test (completed, with the new setup and
// only those rows, $0: the copy's runs paid), so Undo last run puts the old values back and the answer panel and
// sources read the copied answers. Reads only the sample rows. Returns how many rows went back per column.
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db';
import { writeRunCells } from '../lib/run-cells-write';
import { runInputKey } from '../lib/run-inputs/keys';
import { aiRunStamper, requestRunStamper } from '../lib/run-inputs/stampers';
import type { RunInputStamper } from '../lib/run-inputs/stamp';
import { fillMakes, type Fill } from '../lib/setup-versions/spec';
import { canonical } from '../lib/setup-versions/fields';
import { settingsOf } from '../lib/setup-versions/fields-http';
import { parseRowData } from '../lib/sql-helpers';
import type { TestRecord } from './sheet-test-store';
import { forgetUsage } from './setup-version-write';

interface Pair {
  test_index: number; live_index: number; test_data: string; live_data: string; test_stamps: string | null;
}

const RUN = {
  ai: { runs: 'ai_runs', results: 'ai_results' }, http: { runs: 'http_runs', results: 'http_results' },
} as const;

// A new row of `table` copied from the one with this id, with some columns set (every other column as it is, so a
// column a later migration adds comes along).
function cloneRow(table: string, id: string, set: Record<string, unknown>): void {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
  const values = columns.map(c => (c in set ? '?' : c));
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) SELECT ${values.join(', ')} FROM ${table} WHERE id = ?`;
  db.prepare(sql).run(...columns.filter(c => c in set).map(c => set[c]), id);
}

// Now as SQLite's datetime('now') writes it.
const sqlNow = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);

function samplePairs(t: TestRecord): Pair[] {
  return db.prepare(`SELECT c.row_index AS test_index, l.row_index AS live_index, c.data AS test_data,
      l.data AS live_data, c.run_inputs AS test_stamps
    FROM sheet_test_rows m JOIN rows c ON c.id = m.test_row_id JOIN rows l ON l.id = m.live_row_id
    WHERE m.test_id = ? AND c.sheet_id = ? AND l.sheet_id = ? ORDER BY l.row_index`)
    .all(t.id, t.test_sheet_id, t.sheet_id) as Pair[];
}

// The column's runs on a sheet, newest first (a setup written without running is one too: setup_only).
const runsOf = (kind: 'ai' | 'http', sheetId: string, userId: string, column: string, limit = -1) => (kind === 'ai'
  ? db.prepare(`SELECT * FROM ai_runs WHERE sheet_id = ? AND user_id = ? AND column_name = ?
    ORDER BY rowid DESC LIMIT ?`)
  : db.prepare(`SELECT * FROM http_runs WHERE sheet_id = ? AND user_id = ? AND master_column_name = ?
    ORDER BY rowid DESC LIMIT ?`)).all(sheetId, userId, column, limit) as Array<Record<string, any>>;
const newestRun = (kind: 'ai' | 'http', sheetId: string, userId: string, column: string) =>
  runsOf(kind, sheetId, userId, column, 1)[0] as Record<string, any> | undefined;

// What a run's cells would hold, as one string: runs of a column with the same are one setup (a rerun of some rows
// is; how many rows at once and the search engine a run resolved aren't part of it, nor an HTTP run's own rows).
const AI_SETUP = ['prompt', 'system_prompt', 'model', 'temperature', 'max_chars', 'use_openrouter_web_search',
  'use_web_fetch', 'output_columns', 'data_column', 'web_search_engine', 'web_search_mode', 'web_search_max_per_row',
  'run_if', 'web_fetch_max_content_tokens', 'web_fetch_max_pages'];
const parsed = (raw: unknown): unknown => {
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw ?? null; } catch { return raw; }
};
const setupOf = (kind: 'ai' | 'http', run: Record<string, any>): string => (kind === 'ai'
  ? canonical(AI_SETUP.map(k => (k === 'output_columns' ? parsed(run[k]) : run[k] ?? null)))
  : canonical([settingsOf((parsed(run.config) ?? {}) as Record<string, any>), run.dest_sheet_id ?? null]));

function stampOf(t: TestRecord, column: string, pair: Pair): string | null {
  const key = runInputKey(t.test_sheet_id, t.user_id, column);
  if (key === null || !pair.test_stamps) return null;
  try { return (JSON.parse(pair.test_stamps) as Record<string, string>)[String(key)] ?? null; } catch { return null; }
}

function keepColumn(t: TestRecord, column: string, fill: Fill, pairs: Pair[]): number {
  const kind = fill.kind === 'ai' ? 'ai' : 'http';
  const r = RUN[kind];
  const runs = runsOf(kind, t.test_sheet_id, t.user_id, column);
  const fresh = newestRun(kind, t.sheet_id, t.user_id, column);
  if (!runs.length || !fresh) return 0;
  const want = setupOf(kind, runs[0]);
  const same = new Set(runs.filter(run => setupOf(kind, run) === want).map(run => run.id as string));
  const stamper: RunInputStamper | null = kind === 'ai' ? aiRunStamper(fresh as never)
    : requestRunStamper(fresh as never, JSON.parse(fresh.config));
  if (!stamper) return 0;
  const resultIn = db.prepare(`SELECT id, status FROM ${r.results} WHERE run_id = ? AND row_index = ? AND undone = 0
    ORDER BY rowid DESC LIMIT 1`);
  // The row's newest result: the one its cells hold (an undone one put them back), if a run set up so answered it.
  const madeNow = (index: number): string | null => {
    for (const run of runs) {
      const res = resultIn.get(run.id, index) as { id: string; status: string } | undefined;
      if (res) return res.status === 'completed' && same.has(run.id) ? res.id : null;
    }
    return null;
  };
  const kept = pairs.flatMap(p => {
    const resultId = madeNow(p.test_index);
    const stamp = stamper.stamp(p.live_data);
    return resultId && stampOf(t, column, p) === stamp.fp ? [{ p, resultId, stamp }] : [];
  });
  if (!kept.length) return 0;
  const runId = uuidv4();
  cloneRow(r.runs, fresh.id, {
    id: runId, setup_only: 0, status: 'completed', total_rows: kept.length, processed_rows: kept.length,
    target_rows: JSON.stringify(kept.map(k => k.p.live_index)), created_at: sqlNow(), updated_at: sqlNow(),
  });
  const writes = [column, ...fillMakes(fill, column).filter(c => c !== column)];
  for (const { p, resultId, stamp } of kept) {
    const data = parseRowData(p.test_data);
    const cells = writes.map(c => [c, data[c] === undefined || data[c] === null ? '' : String(data[c])] as
      [string, string]);
    writeRunCells({ kind, id: runId }, t.sheet_id, t.user_id, p.live_index, cells, stamp);
    cloneRow(r.results, resultId, { id: uuidv4(), run_id: runId, row_index: p.live_index, cost_usd: 0,
      ...(kind === 'ai' ? { provider_cost_usd: 0 } : {}) });
  }
  // It ran nothing: usage lists what ran (the copy's runs, which paid).
  forgetUsage(runId);
  return kept.length;
}

// The columns to put back (their written setups by name) → rows put back per column.
export function keepTestResults(t: TestRecord, fills: Map<string, Fill>): Record<string, number> {
  const pairs = samplePairs(t);
  const out: Record<string, number> = {};
  for (const [column, fill] of fills) {
    if (fill.kind !== 'ai' && fill.kind !== 'http') continue;
    const n = keepColumn(t, column, fill, pairs);
    if (n > 0) out[column] = n;
  }
  return out;
}
