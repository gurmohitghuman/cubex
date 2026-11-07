// A run that ended before it wrote a row (cancelled, or failed to start, with
// every row still ⏳) leaves nothing to undo once its clear has put the cells
// back (lib/run-undo/unused.ts): its journal goes, so "Undo last run" offers
// the run before it at once, the run reads as having nothing to undo (never as
// undone, and History shows no undo), and the prune sweep deletes what it kept.
// A run that wrote one row keeps its journal, and so does one whose "Only run
// if" rule marked rows at its start (cells it wrote, with no result row).
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
import lifecycleMod from '../../server/src/services/run-lifecycle'
import seedRunMod from '../../server/src/services/run-seed'
import busyMod from '../../server/src/lib/sheet-busy'
import cellsMod from '../../server/src/lib/placeholder-cells'
import writeMod from '../../server/src/lib/run-cells-write'
import journalMod from '../../server/src/lib/run-undo/journal'
import markersMod from '../../server/src/lib/run-markers'
import viewMod from '../../server/src/services/run-undo-view'
import undoMod from '../../server/src/services/run-undo'
import pruneMod from '../../server/src/services/run-undo-prune'
const { cancelRun } = lifecycleMod as typeof import('../../server/src/services/run-lifecycle')
const { seedThenEnqueue } = seedRunMod as typeof import('../../server/src/services/run-seed')
const { withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { seedProcessingPlaceholders, PLACEHOLDER } = cellsMod as typeof import('../../server/src/lib/placeholder-cells')
const { writeRunCells } = writeMod as typeof import('../../server/src/lib/run-cells-write')
const { journalSeed } = journalMod as typeof import('../../server/src/lib/run-undo/journal')
const { CONDITION_NOT_MET } = markersMod as typeof import('../../server/src/lib/run-markers')
const { undoViewOf, lastUndoable } = viewMod as typeof import('../../server/src/services/run-undo-view')
const { undoRun } = undoMod as typeof import('../../server/src/services/run-undo')
const { pruneRunUndos } = pruneMod as typeof import('../../server/src/services/run-undo-prune')
const { db, uid, ok, done, sheet, cells, run, journal, journalRows } = undoKit('run-end-nothing-to-undo')
console.error = () => {}

type Kind = 'ai' | 'http'
const TABLE = { ai: 'ai_runs', http: 'http_runs' } as const
const until = async (what: string, cond: () => boolean, ms = 15_000) => {
  for (const end = Date.now() + ms; !cond();) {
    if (Date.now() > end) throw new Error(`Timed out waiting until ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}
const workOf = (kind: Kind, id: string) => db.prepare(`SELECT placeholder_work FROM ${TABLE[kind]} WHERE id = ?`)
  .pluck().get(id) as string | null
// A rerun of V on every row, as a worker has it: running, ⏳ seeded, what V held kept in its journal first.
const rerun = async (sid: string, status = 'running', work: string | null = null) => {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,placeholder_work)
    VALUES (?,?,?,'{}',?,'V',?)`).run(id, sid, uid, status, work)
  return id
}
const seedAll = (id: string, sid: string) => seedProcessingPlaceholders({ run: { kind: 'http', id }, sheetId: sid,
  userId: uid, columns: ['V'], targets: null, lastRow: 1, live: () => true })
// One row answered, as a worker writes it: its result row and its cells, together.
const answer = (id: string, sid: string, row: number, value: string) => db.transaction(() => {
  db.prepare(`INSERT INTO http_results (id,run_id,user_id,row_index,status) VALUES (?,?,?,?,'completed')`)
    .run(uuid(), id, uid, row)
  writeRunCells({ kind: 'http', id }, sid, uid, row, [['V', value]])
})()
const cancel = async (id: string) => {
  assert.deepEqual(await cancelRun('http', id, uid), { ok: true })
  await until('its clear is done', () => workOf('http', id) === null)
}
const undone = (sid: string) => db.prepare(`SELECT COUNT(*) FROM sheet_changes WHERE sheet_id = ?
  AND action = 'run_undone'`).pluck().get(sid) as number
const NOTHING = /^This run has nothing to undo: it wrote no cells/

await ok('a rerun cancelled before any row ran: nothing to undo, and Undo last run takes the run before it at once',
  async () => {
    const sid = sheet([{ V: 'v0' }, { V: 'v1' }], ['V'])
    const first = await run(sid, 'http', ['V'], { 0: ['one'], 1: ['uno'] })
    const second = await rerun(sid)
    await seedAll(second, sid)
    assert.deepEqual(cells(sid, 'V'), [PLACEHOLDER, PLACEHOLDER])
    const kept = journal('http', second)!
    assert.equal(kept.row_count, 2)
    await cancel(second)
    assert.deepEqual(cells(sid, 'V'), ['one', 'uno'])
    assert.equal(journal('http', second)!.state, 'dropping')
    const view = undoViewOf(uid, 'http', second)!
    assert.deepEqual([view.state, view.rows, view.can_undo, view.undone_at], ['none', 0, false, null])
    assert.match(view.reason!, NOTHING)
    const out = await undoRun(uid, 'http', second)
    assert.ok('fail' in out && NOTHING.test(out.message), JSON.stringify(out))
    assert.equal(undone(sid), 0, 'History says nothing was undone')
    const last = lastUndoable(uid, sid, 'V')!
    assert.deepEqual([last.run_id, last.can_undo], [first, true])
    const back = await undoRun(uid, 'http', first)
    assert.ok('ok' in back, JSON.stringify(back))
    assert.deepEqual(cells(sid, 'V'), ['v0', 'v1'])
    assert.equal(undone(sid), 1)
    // The prune sweep deletes what it kept, and it still reads as nothing to undo.
    await pruneRunUndos()
    assert.equal(journal('http', second), undefined)
    assert.equal(journalRows(kept.id), 0)
    assert.equal(undoViewOf(uid, 'http', second)!.state, 'none')
  })

await ok('a run cancelled after one row keeps its journal: Undo last run takes it', async () => {
  const sid = sheet([{ V: 'v0' }, { V: 'v1' }], ['V'])
  await run(sid, 'http', ['V'], { 0: ['one'], 1: ['uno'] })
  const second = await rerun(sid)
  await seedAll(second, sid)
  answer(second, sid, 0, 'two')
  await cancel(second)
  assert.deepEqual(cells(sid, 'V'), ['two', 'uno'])
  assert.equal(journal('http', second)!.state, 'kept')
  const last = lastUndoable(uid, sid, 'V')!
  assert.deepEqual([last.run_id, last.can_undo, last.rows], [second, true, 2])
  assert.ok('ok' in await undoRun(uid, 'http', second))
  assert.deepEqual(cells(sid, 'V'), ['one', 'uno'])
})

await ok('an "Only run if" rule marked a row at its start: a cell it wrote, so its journal stays', async () => {
  const sid = sheet([{ V: '' }, { V: 'v1' }], ['V'])
  const id = await rerun(sid)
  const [r0, r1] = db.prepare('SELECT rowid FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sid)
  db.transaction(() => {
    journalSeed({ kind: 'http', id }, sid, uid, { rowids: JSON.stringify([r0]) }, [['V', CONDITION_NOT_MET]])
    journalSeed({ kind: 'http', id }, sid, uid, { rowids: JSON.stringify([r1]) }, [['V', PLACEHOLDER]])
    db.prepare(`UPDATE rows SET data = json_set(data, '$.V', CASE rowid WHEN ? THEN ? ELSE ? END)
      WHERE sheet_id = ?`).run(r0, CONDITION_NOT_MET, PLACEHOLDER, sid)
  })()
  await cancel(id)
  assert.deepEqual(cells(sid, 'V'), [CONDITION_NOT_MET, 'v1'])
  assert.equal(journal('http', id)!.state, 'kept')
  assert.equal(lastUndoable(uid, sid, 'V')?.run_id, id)
  assert.ok('ok' in await undoRun(uid, 'http', id))
  assert.deepEqual(cells(sid, 'V'), ['', 'v1'])
})

await ok('an AI rerun that failed to start after seeding: nothing to undo either', async () => {
  const sid = sheet([{ V: 'v0' }, { V: 'v1' }], ['V'])
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status,placeholder_work)
    VALUES (?,?,?,'V','p','pending','seeding')`).run(id, sid, uid)
  await withSheetBusy(sid, 'starting a run', async () => {
    seedThenEnqueue({ kind: 'ai', runId: id, sheetId: sid, userId: uid, columns: ['V'], targets: null, lastRow: 1,
      enqueue: async () => { throw new Error('the queue is down') } })
  })
  await until('the start failed and its clear is done', () => workOf('ai', id) === null
    && (db.prepare('SELECT status FROM ai_runs WHERE id = ?').pluck().get(id) as string) === 'failed')
  assert.deepEqual(cells(sid, 'V'), ['v0', 'v1'])
  assert.equal(journal('ai', id)!.state, 'dropping')
  assert.equal(undoViewOf(uid, 'ai', id)!.state, 'none')
})

done()
