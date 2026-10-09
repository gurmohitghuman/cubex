// Settings' "Stored answers": how much space enrichment answers take
// (http_results.response_data of enrichment runs), from a background count
// that walks the account's runs and their results a slice at a time and keeps
// its last result in answer_store_size with when it was counted. Opening
// Settings counts again when that is over an hour old; a prune counts again
// when it ends. octet_length reads a value's size without reading the value.
import { db } from '../lib/db';
import { HEAVY_JOB_RETRY_MS, STORED_ANSWERS_PRUNE_DAYS, STORED_ANSWERS_RECOUNT_MS } from '../lib/constants';
import { yieldToRequests } from '../lib/slices';
import { walkRunResults, type WalkPos } from './run-results-walk';

export interface StoredAnswersView {
  bytes: number | null;          // null: never counted
  answers: number | null;
  countedAt: string | null;      // ISO
  counting: boolean;
  pruneDays: number;
  prune: {
    status: 'running' | 'done' | 'failed'; pruned: number; startedAt: string; endedAt: string | null;
  } | null;
}

const counting = new Set<string>();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const iso = (sqlTime: string) => `${sqlTime.replace(' ', 'T')}Z`;

// One run's answers: their count and size. Waits out a busy sheet; starts
// the run over when its rows moved.
async function countRun(run: { id: string; sheet_id: string }, userId: string) {
  const sizeOf = db.prepare(`SELECT COUNT(*) AS n, IFNULL(SUM(octet_length(response_data)), 0) AS b
    FROM http_results WHERE rowid IN (SELECT value FROM json_each(?)) AND +user_id = ?`);
  let total = { n: 0, b: 0 };
  let from: WalkPos = { cursor: -1, generation: null };
  for (;;) {
    const outcome = await walkRunResults({
      runId: run.id, sheetId: run.sheet_id, userId, answered: true, from,
      restarted: () => { total = { n: 0, b: 0 }; },
      step: (slice, to) => {
        const s = sizeOf.get(JSON.stringify(slice.rowids), userId) as { n: number; b: number };
        total = { n: total.n + s.n, b: total.b + s.b };
        from = to;
      },
    });
    if (outcome === 'done') return total;
    await sleep(HEAVY_JOB_RETRY_MS);
  }
}

async function count(userId: string): Promise<void> {
  const next = db.prepare(`SELECT rowid AS rid, id, sheet_id FROM http_runs WHERE user_id = ? AND rowid > ?
    AND json_type(config, '$.enrichment') IS NOT NULL ORDER BY rowid LIMIT 1`);
  let bytes = 0, answers = 0, after = 0;
  for (;;) {
    const run = next.get(userId, after) as { rid: number; id: string; sheet_id: string } | undefined;
    if (!run) break;
    const t = await countRun(run, userId);
    bytes += t.b;
    answers += t.n;
    after = run.rid;
    await yieldToRequests();
  }
  db.prepare(`INSERT INTO answer_store_size (user_id, bytes, answers, counted_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET bytes = excluded.bytes, answers = excluded.answers,
      counted_at = excluded.counted_at`).run(userId, bytes, answers);
}

// Starts a count unless one is going, or (without `force`) the last one is recent.
export function countStoredAnswers(userId: string, force = false): void {
  if (counting.has(userId)) return;
  if (!force) {
    const at = db.prepare('SELECT counted_at FROM answer_store_size WHERE user_id = ?').pluck().get(userId) as
      string | undefined;
    if (at && Date.now() - Date.parse(iso(at)) < STORED_ANSWERS_RECOUNT_MS) return;
  }
  counting.add(userId);
  void count(userId)
    .catch(err => console.error('Counting stored answers failed:', err))
    .finally(() => counting.delete(userId));
}

export function storedAnswersView(userId: string): StoredAnswersView {
  const size = db.prepare('SELECT bytes, answers, counted_at FROM answer_store_size WHERE user_id = ?')
    .get(userId) as { bytes: number; answers: number; counted_at: string } | undefined;
  const job = db.prepare(`SELECT status, pruned, created_at, updated_at FROM answer_prune_jobs
    WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(userId) as
    { status: 'running' | 'done' | 'failed'; pruned: number; created_at: string; updated_at: string } | undefined;
  // A count during a prune would be out of date at once; the prune counts when it ends.
  if (job?.status !== 'running') countStoredAnswers(userId);
  return {
    bytes: size?.bytes ?? null,
    answers: size?.answers ?? null,
    countedAt: size ? iso(size.counted_at) : null,
    counting: counting.has(userId),
    pruneDays: STORED_ANSWERS_PRUNE_DAYS,
    prune: job ? {
      status: job.status, pruned: job.pruned, startedAt: iso(job.created_at),
      endedAt: job.status === 'running' ? null : iso(job.updated_at),
    } : null,
  };
}
