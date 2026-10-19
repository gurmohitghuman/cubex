// An undone run's results and journals (lib/run-undo/, migration 044): a row
// whose main cell the undo put back stops counting as the cell's answer (the
// answer panel, a column added from stored answers, an AI "(Data)" cell's
// sources) and is never reused for free, while a row the undo skipped keeps
// its answer; an older list job's ➕ comes back only for that column's own
// pending results; a run started before runs could be undone keeps nothing.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
const { db, uid, ok, done, idle, sheet, cells, edit, run, journal } = undoKit('run-undo-results')

const { undoRun } = await import('../../server/src/services/run-undo')
const { undoViewOf } = await import('../../server/src/services/run-undo-view')
const { resultAtRow, statusColumnRuns } = await import('../../server/src/services/answer-runs')
const { findReusable } = await import('../../server/src/services/enrich-reuse')
const { addAnswerField } = await import('../../server/src/services/answer-field-add')
const { journalSeed } = await import('../../server/src/lib/run-undo/journal')
const { writeRunCells } = await import('../../server/src/lib/run-cells-write')

const undo = async (kind: 'ai' | 'http', runId: string) => {
  const out = await undoRun(uid, kind, runId)
  if ('fail' in out) throw new Error(`undo refused: ${out.message}`)
  return out.ok
}
const MAPPING = JSON.stringify({ responseMapping: [] })
// A stored answer at each row of an HTTP run (as its writers leave them), with a reuse key.
const answers = (runId: string, byRow: Record<number, string>) => {
  db.prepare('UPDATE http_runs SET config = ? WHERE id = ?').run(MAPPING, runId)
  const ins = db.prepare(`INSERT INTO http_results (id, run_id, user_id, row_index, response_data, status,
    reuse_key, answered_at) VALUES (?, ?, ?, ?, ?, 'completed', ?, '2026-10-19T00:00:00.000Z')`)
  for (const [i, v] of Object.entries(byRow)) {
    ins.run(uuid(), runId, uid, Number(i), JSON.stringify({ v }), `key-${v}`)
  }
}
const answerAt = (sid: string, column: string, row: number) => {
  const hit = resultAtRow(statusColumnRuns(sid, uid, column), uid, row)
  return hit ? { run: hit.run.id, v: (JSON.parse(hit.response_data ?? 'null') as { v: string }).v } : null
}

await ok('an undone rerun: restored rows answer from the run before; a skipped row keeps its answer', async () => {
  const sid = sheet([{ Q: 'q0' }, { Q: 'q1' }, { Q: 'q2' }], ['Q', 'E'])
  const e1 = await run(sid, 'http', ['E'], { 0: ['one0'], 1: ['one1'], 2: ['one2'] })
  answers(e1, { 0: 'one0', 1: 'one1', 2: 'one2' })
  const e2 = await run(sid, 'http', ['E'], { 0: ['two0'], 1: ['two1'] })
  answers(e2, { 0: 'two0', 1: 'two1' })
  edit(sid, 1, 'E', 'mine')
  const out = await undo('http', e2)
  // Row 2: the rerun's ⏳ there was cleared when it stopped, and comes back too.
  assert.deepEqual([out.restored, out.skipped], [2, 1])
  assert.deepEqual(cells(sid, 'E'), ['one0', 'mine', 'one2'])
  // Row 0 came back: E1's answer; row 1 was skipped: still E2's.
  assert.deepEqual(answerAt(sid, 'E', 0), { run: e1, v: 'one0' })
  assert.deepEqual(answerAt(sid, 'E', 1), { run: e2, v: 'two1' })
  assert.deepEqual(answerAt(sid, 'E', 2), { run: e1, v: 'one2' })
  // The undone answer is never reused; the skipped row's still is, and E1's too.
  const since = '2000-01-01T00:00:00.000Z'
  assert.equal(findReusable(uid, 'key-two0', since, uuid()), null)
  assert.equal(findReusable(uid, 'key-two1', since, uuid())?.from.run_id, e2)
  assert.equal(findReusable(uid, 'key-one0', since, uuid())?.from.run_id, e1)
  const flags = db.prepare('SELECT row_index, undone FROM http_results WHERE run_id = ? ORDER BY row_index')
    .raw().all(e2)
  assert.deepEqual(flags, [[0, 1], [1, 0]])
})

await ok('a column added from stored answers after an undo reads the run before at restored rows', async () => {
  const sid = sheet([{ Q: 'q0' }, { Q: 'q1' }], ['Q', 'F'])
  const e1 = await run(sid, 'http', ['F'], { 0: ['a0'], 1: ['a1'] })
  answers(e1, { 0: 'a0', 1: 'a1' })
  const e2 = await run(sid, 'http', ['F'], { 0: ['b0'], 1: ['b1'] })
  answers(e2, { 0: 'b0', 1: 'b1' })
  edit(sid, 1, 'F', 'mine')
  await undo('http', e2)
  await idle(sid)
  const out = await addAnswerField(uid, sid, { column: 'F', jsonPath: '$.v', name: 'V', row: null })
  assert.ok('ok' in out, JSON.stringify(out))
  await idle(sid)
  assert.deepEqual(cells(sid, 'V'), ['a0', 'b1'])
})

await ok("an undone AI run's result at a restored row is passed over; a skipped row's stays", async () => {
  const sid = sheet([{ O: 'before0' }, { O: 'before1' }], ['O'])
  const runId = await run(sid, 'ai', ['O'], { 0: ['new0'], 1: ['new1'] })
  const ins = db.prepare(`INSERT INTO ai_results (id, run_id, user_id, row_index, output_value, status, scraped_data)
    VALUES (?, ?, ?, ?, ?, 'completed', '{"sources":[]}')`)
  ins.run(uuid(), runId, uid, 0, 'new0')
  ins.run(uuid(), runId, uid, 1, 'new1')
  edit(sid, 1, 'O', 'mine')
  await undo('ai', runId)
  assert.deepEqual(cells(sid, 'O'), ['before0', 'mine'])
  assert.deepEqual(db.prepare('SELECT row_index, undone FROM ai_results WHERE run_id = ? ORDER BY row_index')
    .raw().all(runId), [[0, 1], [1, 0]])
})

await ok("an older list job's ➕ comes back only while that column's own results are on their way", async () => {
  const sid = sheet([{ X: '➕ Adding 3 rows…', Y: '' }], ['X', 'Y'])
  const runId = await run(sid, 'http', ['X'], { 0: ['✅ Found'] })
  const rowId = db.prepare('SELECT id FROM rows WHERE sheet_id = ?').pluck().get(sid) as string
  // A list job of ANOTHER column (Y) is pending on the same row: X's words wouldn't ever be replaced.
  const other = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','completed','Y')`).run(other, sid, uid)
  db.prepare(`INSERT INTO enrichment_list_items (id,user_id,run_id,source_sheet_id,source_row_id,dest_sheet_id,
    items_json,item_count) VALUES (?,?,?,?,?,?,'[]',2)`).run(uuid(), uid, other, sid, rowId, sid)
  await undo('http', runId)
  assert.deepEqual(cells(sid, 'X'), [''])
})

await ok('a run started before runs could be undone keeps nothing and writes as usual', async () => {
  const sid = sheet([{ P: 'real data' }, { P: 'more' }], ['P'])
  const runId = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,created_at)
    VALUES (?,?,?,'{}','running','P','2000-01-01 00:00:00')`).run(runId, sid, uid)
  // Seeded before the upgrade: ⏳ written with nothing kept.
  db.prepare(`UPDATE rows SET data = json_set(data, '$.P', '⏳ Processing...') WHERE sheet_id = ?`).run(sid)
  const rowids = JSON.stringify(db.prepare('SELECT rowid FROM rows WHERE sheet_id = ?').pluck().all(sid))
  // A re-seed after the restart keeps nothing either.
  db.transaction(() => journalSeed({ kind: 'http', id: runId }, sid, uid, { rowids }, [['P', '⏳ Processing...']]))()
  assert.equal(writeRunCells({ kind: 'http', id: runId }, sid, uid, 0, [['P', 'answer']]), true)
  assert.deepEqual(cells(sid, 'P'), ['answer', '⏳ Processing...'])
  assert.equal(journal('http', runId), undefined)
  db.prepare("UPDATE http_runs SET status = 'completed' WHERE id = ?").run(runId)
  const view = undoViewOf(uid, 'http', runId)!
  assert.deepEqual([view.state, view.can_undo], ['none', false])
  assert.match(view.reason ?? '', /before runs could be undone/)
})

done()
