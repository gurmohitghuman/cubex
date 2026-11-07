// Over 200 lines: one fixture of runs and journals; each case a way a run's journal goes or stays.
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
import constMod from '../../server/src/lib/constants'
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
const { UNDO_EMPTY_CHECK_ROWS } = constMod as typeof import('../../server/src/lib/constants')
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

// 5,001 rows of 3 columns (a page of the check: UNDO_EMPTY_CHECK_ROWS / 4 = 5,000 rows), a rerun on every row as
// its seeding leaves it; `mark`: the last row kept out by an "Only run if" rule instead, its only cell written but
// no result row, so only the journal's second page tells.
const COLS = ['C1', 'C2', 'C3']
const N = UNDO_EMPTY_CHECK_ROWS / 4 + 1
async function widePages(mark: boolean) {
  const sid = sheet(Array.from({ length: N }, (_, i) => Object.fromEntries(COLS.map(c => [c, `${c} ${i}`]))), COLS)
  const id = await rerun(sid)
  // Its status column C1, its mapped columns C2 and C3 (its clear puts back all three).
  db.prepare("UPDATE http_runs SET master_column_name = 'C1' WHERE id = ?").run(id)
  for (const c of COLS.slice(1)) {
    db.prepare(`INSERT INTO http_column_associations (id,sheet_id,user_id,master_column_name,extracted_column_name,
      run_id) VALUES (?,?,?,'C1',?,?)`).run(uuid(), sid, uid, c, id)
  }
  const rowids = db.prepare('SELECT rowid FROM rows WHERE sheet_id = ? ORDER BY rowid').pluck().all(sid) as number[]
  const seeded = JSON.stringify(mark ? rowids.slice(0, -1) : rowids)
  const set = db.prepare(`UPDATE rows SET data = json_set(data, '$.C1', ?, '$.C2', ?, '$.C3', ?)
    WHERE rowid IN (SELECT value FROM json_each(?))`)
  db.transaction(() => {
    journalSeed({ kind: 'http', id }, sid, uid, { rowids: seeded }, COLS.map(c => [c, PLACEHOLDER]))
    set.run(PLACEHOLDER, PLACEHOLDER, PLACEHOLDER, seeded)
    if (!mark) return
    const last = JSON.stringify(rowids.slice(-1))
    journalSeed({ kind: 'http', id }, sid, uid, { rowids: last }, [['C1', CONDITION_NOT_MET], ['C2', ''], ['C3', '']])
    set.run(CONDITION_NOT_MET, '', '', last)
  })()
  // Each read of the check's pages: where it went on from and how many rows it asked for.
  const pages: Array<[number, number]> = []
  const prepare = db.prepare
  db.prepare = ((sql: string) => {
    const st = prepare.call(db, sql)
    if (!sql.startsWith('SELECT MAX(row_id), MAX(EXISTS')) return st
    return new Proxy(st, { get(t, key) {
      if (key === 'raw') return (...a: unknown[]) => new Proxy(t.raw(...a), { get(r, k) {
        if (k === 'get') return (...g: number[]) => { pages.push([g[1], g[2]]); return r.get(...g) }
        const v = Reflect.get(r, k)
        return typeof v === 'function' ? v.bind(r) : v
      } })
      const v = Reflect.get(t, key)
      return typeof v === 'function' ? v.bind(t) : v
    } })
  }) as typeof db.prepare
  try { await cancel(id) } finally { db.prepare = prepare }
  return { sid, id, rowids, pages }
}

await ok('3 columns, 5,001 rows, a rule\'s mark only on the last: the check reads its second page and keeps it',
  async () => {
    const { sid, id, rowids, pages } = await widePages(true)
    assert.equal(journal('http', id)!.state, 'kept')
    assert.deepEqual(pages, [[0, 5_000], [rowids[4_999], 5_000]])
    assert.equal(lastUndoable(uid, sid, 'C1')?.run_id, id)
  })

await ok('3 columns, 5,001 rows, nothing but ⏳: the check reads both pages and the journal goes', async () => {
  const { sid, id, rowids, pages } = await widePages(false)
  assert.equal(journal('http', id)!.state, 'dropping')
  assert.deepEqual(pages, [[0, 5_000], [rowids[4_999], 5_000], [rowids[5_000], 5_000]])
  assert.deepEqual([cells(sid, 'C3')[0], cells(sid, 'C3')[N - 1]], ['C3 0', `C3 ${N - 1}`])
})

done()
