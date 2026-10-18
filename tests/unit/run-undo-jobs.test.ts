// Undoing a run as a job (services/run-undo*.ts): a big undo answers at once
// and finishes in the background, a restart goes on from the cursor, old
// journals and an emptied sheet's are dropped (a running run's stay), the
// "Only run if" seeding keeps what it overwrites, and an undo tells clean and
// formula columns to follow while no run's auto-run hears of it.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
const { db, uid, ok, done, idle, sheet, cells, run, journal, journalRows } = undoKit('run-undo-jobs')

const { undoRun, resumeRunUndos } = await import('../../server/src/services/run-undo')
const { pruneRunUndos, dropSheetUndos } = await import('../../server/src/services/run-undo-prune')
const { seedPlaceholdersByRule } = await import('../../server/src/lib/placeholder-rule-seed')
const { UNDO_WAIT_ROWS, UNDO_KEEP_DAYS } = await import('../../server/src/lib/constants')
const { startCleanColumn } = await import('../../server/src/services/clean-column')
const { derivedFollowTick } = await import('../../server/src/services/derived-follow')
const { entryFor } = await import('../../server/src/services/autorun-entry')
const { markAutorunInputs } = await import('../../server/src/lib/autorun-mark')

const many = (n: number) => Array.from({ length: n }, (_, i) => ({ K: `k${i}`, Out: i % 2 ? `old${i}` : '' }))
const results = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i, [`new${i}`]]))

await ok('a big undo answers at once (undoing) and finishes in the background, the sheet busy meanwhile', async () => {
  const n = UNDO_WAIT_ROWS + 5_000
  const sid = sheet(many(n), ['K', 'Out'])
  const runId = await run(sid, 'http', ['Out'], results(n))
  const t = Date.now()
  const out = await undoRun(uid, 'http', runId)
  assert.ok('ok' in out)
  assert.equal(out.ok.state, 'undoing')
  assert.ok(Date.now() - t < 2_000, 'it answered without waiting for the rows')
  await idle(sid)
  const j = journal('http', runId)!
  assert.equal(j.state, 'undone')
  assert.equal(j.restored, n)
  const back = cells(sid, 'Out')
  assert.equal(back[1], 'old1')
  assert.equal(back[2], '')
  assert.equal(back[n - 1], `old${n - 1}`)
})

await ok('a restart goes on from the cursor: rows before it stay as they are', async () => {
  const sid = sheet(many(10), ['K', 'Out'])
  const runId = await run(sid, 'http', ['Out'], results(10))
  const rids = db.prepare('SELECT rowid FROM rows WHERE sheet_id = ? ORDER BY rowid').pluck().all(sid) as number[]
  const j = journal('http', runId)!
  db.prepare("UPDATE run_undos SET state = 'undoing', cursor = ? WHERE id = ?").run(rids[4], j.id)
  resumeRunUndos()
  await new Promise(r => setTimeout(r, 20))
  await idle(sid)
  assert.equal(journal('http', runId)!.state, 'undone')
  const back = cells(sid, 'Out')
  assert.deepEqual(back.slice(0, 5), ['new0', 'new1', 'new2', 'new3', 'new4'])
  assert.deepEqual(back.slice(5), ['old5', '', 'old7', '', 'old9'])
  assert.equal(journal('http', runId)!.restored, 5)
})

await ok(`journals older than ${UNDO_KEEP_DAYS} days go once their run stopped; an emptied sheet's go`, async () => {
  const sid = sheet(many(3), ['K', 'Out'])
  const stopped = await run(sid, 'http', ['Out'], results(3))
  const going = await run(sid, 'ai', ['K'], { 0: ['x'] }, { status: 'running' })
  const fresh = await run(sid, 'http', ['Out'], results(3))
  db.prepare(`UPDATE run_undos SET created_at = datetime('now', '-8 days') WHERE run_id IN (?, ?)`).run(stopped, going)
  const sj = journal('http', stopped)!
  await pruneRunUndos()
  assert.equal(journal('http', stopped), undefined)
  assert.equal(journalRows(sj.id), 0)
  assert.equal(journal('ai', going)?.state, 'kept')
  assert.equal(journal('http', fresh)?.state, 'kept')
  const out = await undoRun(uid, 'http', stopped)
  assert.ok('fail' in out && /nothing to undo/.test(out.message))
  const fj = journal('http', fresh)!
  await dropSheetUndos(sid)
  assert.equal(journal('http', fresh), undefined)
  assert.equal(journalRows(fj.id), 0)
})

await ok('"Only run if" seeding keeps what its ⏭️ marks overwrite', async () => {
  const sid = sheet([{ Go: 'yes', Out: '❌ Error: before' }, { Go: 'no', Out: '❌ Error: old' }], ['Go', 'Out'])
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','running','Out')`).run(id, sid, uid)
  const rule = {
    tree: { kind: 'cmp' as const, column: 'Go', op: 'is' as const, value: 'yes', numeric: false },
    columns: ['Go'], markColumn: 'Out',
  }
  await seedPlaceholdersByRule({ run: { kind: 'http', id }, sheetId: sid, userId: uid, columns: ['Out'], rule,
    targets: null, lastRow: 1, live: () => true })
  assert.deepEqual(cells(sid, 'Out'), ['⏳ Processing...', '⏭️ Condition not met'])
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Out', '✅ Success') WHERE sheet_id = ? AND row_index = 0`)
    .run(sid)
  db.prepare("UPDATE http_runs SET status = 'completed' WHERE id = ?").run(id)
  const out = await undoRun(uid, 'http', id)
  assert.ok('ok' in out, JSON.stringify(out))
  // Row 0's result was written outside the run's writer (a person, as far as the journal knows): skipped.
  assert.deepEqual(cells(sid, 'Out'), ['✅ Success', '❌ Error: old'])
})

await ok('a clean column follows the restored cells quietly: a paid auto-run reading it never hears', async () => {
  const sid = sheet([{ Out: 'OLD@A.COM' }, { Out: '' }], ['Out', 'Hook'])
  const runId = await run(sid, 'http', ['Out'], { 0: ['NEW@A.COM'], 1: ['TWO@B.COM'] })
  const started = await startCleanColumn(uid, sid, { source: 'Out', cleaner: 'lowercase', column: 'Low' })
  assert.ok('ok' in started, JSON.stringify(started))
  await idle(sid)
  assert.deepEqual(cells(sid, 'Low'), ['new@a.com', 'two@b.com'])
  const hook = uuid()
  db.prepare(`INSERT INTO autorun_columns (id,user_id,sheet_id,status_column,kind,input_columns)
    VALUES (?,?,?,'Hook','http','["Low"]')`).run(hook, uid, sid)
  const pendingFor = (id: string) => db.prepare('SELECT COUNT(*) FROM autorun_pending WHERE autorun_id = ?')
    .pluck().get(id) as number
  const out = await undoRun(uid, 'http', runId)
  assert.ok('ok' in out)
  const low = entryFor(sid, uid, 'Low')!
  assert.equal(pendingFor(low.id), 2)
  await derivedFollowTick(low)
  assert.deepEqual(cells(sid, 'Low'), ['old@a.com', ''])
  assert.equal(pendingFor(hook), 0, 'the paid auto-run heard of the undo')
  // A person's edit is loud: the same chain reaches it.
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Out', 'X@Y.COM') WHERE sheet_id = ? AND row_index = 1`).run(sid)
  markAutorunInputs(sid, uid, ['Out'], { indexes: [1] })
  await derivedFollowTick(entryFor(sid, uid, 'Low')!)
  assert.equal(pendingFor(hook), 1)
})

await ok('clean and formula columns reading a restored cell follow it; no run auto-run hears of it', async () => {
  const sid = sheet(many(2), ['K', 'Out', 'F', 'Hook'])
  const runId = await run(sid, 'http', ['Out'], results(2))
  const entry = (kind: string, status: string) => {
    const id = uuid()
    db.prepare(`INSERT INTO autorun_columns (id,user_id,sheet_id,status_column,kind,input_columns)
      VALUES (?,?,?,?,?,'["Out"]')`).run(id, uid, sid, status, kind)
    return id
  }
  const formula = entry('formula', 'F'), http = entry('http', 'Hook')
  db.prepare('DELETE FROM autorun_pending').run()
  const out = await undoRun(uid, 'http', runId)
  assert.ok('ok' in out)
  const pending = (id: string) => db.prepare('SELECT COUNT(*) FROM autorun_pending WHERE autorun_id = ?')
    .pluck().get(id) as number
  assert.equal(pending(formula), 2)
  assert.equal(pending(http), 0)
})

done()
