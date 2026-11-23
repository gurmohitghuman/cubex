// The stored answers' background bulk writers, each measured (bulk-wal-kit.ts): "Add as column" linking the new column
// to a thousand runs and filling it from their answers (services/answer-field-fill.ts, each transaction printed), the
// older answers at rows enriched again pruned (answer-prune.ts) and "Prune details older than 90 days" walking past
// three thousand recent runs to the old one (answer-prune-age.ts). Each checkpoint on the worker held 300 ms: the event
// loop is never held 200 ms, no checkpoint's sync runs on the API thread, the WAL stays under journal_size_limit,
// SQLite's own checkpoint is back on afterwards, and every cell and answer ends where it should.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import { bulkWalKit } from './bulk-wal-kit'
import { transactionLine, type TransactionRecord } from './sqlite-write-probe'
const { db, uid, ok, done, sheet, cells } = undoKit('bulk-wal-answers')
const { runFieldJob } = await import('../../server/src/services/answer-field-fill')
const { pruneSupersededAnswers } = await import('../../server/src/services/answer-prune')
const { startAgePrune, agePruneRunning } = await import('../../server/src/services/answer-prune-age')
const { closeWalCheckpointer } = await import('../../server/src/lib/wal-checkpointer')
console.error = () => {}
const { measure } = bulkWalKit()
// Each transaction of a measured job printed: a slice is one (lib/bulk-slices.ts).
const printed = (m: { records: TransactionRecord[] }) => {
  for (const r of m.records) console.log(`        ${transactionLine(r)}`)
}

const N = 20_000
const config = JSON.stringify({ responseMapping: [], enrichment: { kind: 'waterfall', email: null } })
let tick = 0
// An enrichment run on `column`, created after the ones before it; `ago`: days since it ended.
function run(sid: string, column: string, ago = 0): string {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, created_at,
    updated_at) VALUES (?,?,?,?, 'completed', ?, datetime('now', ?), datetime('now', ?))`)
    .run(id, sid, uid, config, column, `-${ago * 86400 + 100_000 - tick++} seconds`, `-${ago * 86400} seconds`)
  return id
}
// Answers at these rows, all in one transaction.
function answers(runId: string, rows: number[], body: (i: number) => unknown) {
  const ins = db.prepare(`INSERT INTO http_results (id, run_id, user_id, row_index, response_data, status)
    VALUES (?,?,?,?,?, 'completed')`)
  db.transaction(() => { for (const i of rows) ins.run(uuid(), runId, uid, i, JSON.stringify(body(i))) }).immediate()
}
const range = (n: number, step = 1) => Array.from({ length: Math.ceil(n / step) }, (_, k) => k * step)
// A routed answer with a 3,000-byte raw part: a page of its own, so a prune writes a page an answer.
const routed = (i: number) => ({ output: { email: `p${i}@x.co` }, _treg: { outcome: 'hit' }, raw: 'y'.repeat(3000) })
const count = (sql: string, ...params: unknown[]) => db.prepare(sql).pluck().get(...params) as number

await ok('"Add as column" linked to a thousand runs and filled: the WAL copied back on the worker', async () => {
  const sid = sheet(range(N).map(i => ({ Name: `n${i}`, P: `${i}:${'p'.repeat(300)}` })), ['Name', 'Email', 'P'])
  const empty = range(1_000).map(() => run(sid, 'Email'))
  const older = run(sid, 'Email')
  answers(older, range(N), i => ({ output: { title: `o${i}` }, _treg: { outcome: 'hit' }, $fill: 'all' }))
  const newer = run(sid, 'Email')
  answers(newer, range(N, 2), i => ({ output: { title: `w${i}` }, _treg: { outcome: 'hit' }, $fill: 'all' }))
  const job = uuid()
  db.prepare(`INSERT INTO enrichment_field_jobs (id, user_id, sheet_id, status_column, column_name, json_path)
    VALUES (?,?,?, 'Email', 'Title', '$.output.title')`).run(job, uid, sid)
  printed(await measure('the column linked and filled', () => runFieldJob(job), { pastAuto: true }))
  assert.equal(db.prepare('SELECT status FROM enrichment_field_jobs WHERE id = ?').pluck().get(job), 'done')
  assert.equal(count(`SELECT COUNT(*) FROM http_column_associations WHERE extracted_column_name = 'Title'
    AND sheet_id = ?`, sid), empty.length + 2, 'linked to every run')
  assert.deepEqual(cells(sid, 'Title'), range(N).map(i => (i % 2 ? `o${i}` : `w${i}`)), 'each row its newest answer')
})

await ok('older answers at rows enriched again, then answers older than 90 days, pruned: the WAL copied back on '
  + 'the worker', async () => {
  // The runs above are done: only these are due.
  db.prepare('UPDATE http_runs SET answers_pruned = 1').run()
  const sid = sheet([{ Email: 'x' }], ['Email'])
  const a = run(sid, 'Email')
  answers(a, range(4_000), routed)
  const b = run(sid, 'Email')
  answers(b, range(4_000), i => ({ output: { email: `q${i}@x.co` }, _treg: { outcome: 'hit' } }))
  const raw = (id: string) => count(`SELECT COUNT(*) FROM http_results WHERE run_id = ?
    AND json_type(response_data, '$.raw') IS NOT NULL`, id)
  const pruned = (id: string) => count(`SELECT COUNT(*) FROM http_results WHERE run_id = ?
    AND json_type(response_data, '$."$prunedAt"') IS NOT NULL AND json_type(response_data, '$.output') = 'object'
    AND json_type(response_data, '$._treg') = 'object'`, id)
  await measure('the older answers pruned', () => pruneSupersededAnswers(), { pastAuto: true })
  assert.equal(raw(a), 0, 'no older answer keeps its raw part')
  assert.equal(pruned(a), 4_000, 'each keeps output and _treg, and says when it was pruned')
  assert.equal(count('SELECT COUNT(*) FROM http_runs WHERE answers_pruned = 0 AND id IN (?, ?)', a, b), 0)

  const old = run(sid, 'Phone', 120)
  answers(old, range(4_000), routed)
  range(3_000).forEach(() => run(sid, 'Phone', 10))
  const recent = run(sid, 'Phone', 10)
  answers(recent, range(10), routed)
  let job = ''
  await measure('answers older than 90 days pruned', async () => {
    const started = startAgePrune(uid, 90)
    assert.ok('ok' in started, JSON.stringify(started))
    job = started.ok.jobId
    for (const end = Date.now() + 120_000; agePruneRunning(uid) && Date.now() < end;) {
      await new Promise(r => setTimeout(r, 20))
    }
  }, { pastAuto: true })
  assert.equal(db.prepare('SELECT status FROM answer_prune_jobs WHERE id = ?').pluck().get(job), 'done')
  assert.equal(raw(old), 0)
  assert.equal(pruned(old), 4_000)
  assert.equal(count('SELECT pruned FROM answer_prune_jobs WHERE id = ?', job), 4_000)
  assert.equal(raw(recent), 10, 'recent answers stay whole')
})

await closeWalCheckpointer()
done()
