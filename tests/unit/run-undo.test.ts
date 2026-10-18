// Over 200 lines: one fixture, each case a rule of undoing a run pinned on a real migrated DB.
// Undoing a run (lib/run-undo/, services/run-undo*.ts, migration 041): what a
// run overwrote is kept (its ⏳ seeding, each row's result, a list job's
// words), and an undo puts it back, skipping cells changed since, counting
// cells of deleted rows and columns as gone, bringing back run_inputs stamps,
// following renames, never writing into a row that took a deleted one's rowid,
// and refusing a run that still goes or another run writing its columns.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import printMod from '../../server/src/lib/run-undo/print'
import { undoKit } from './run-undo-kit'
const { cellPrint, undoOutcome, PRINT_EMPTY, PRINT_RUNNING } =
  printMod as typeof import('../../server/src/lib/run-undo/print')
const { db, uid, ok, done, idle, sheet, cells, edit, run, journal, journalRows } = undoKit('run-undo')

const { undoRun } = await import('../../server/src/services/run-undo')
const { undoViewOf, lastUndoable } = await import('../../server/src/services/run-undo-view')
const { renameUndoColumn, deleteUndoColumn } = await import('../../server/src/lib/run-undo/columns')
const { journalFollowUp } = await import('../../server/src/lib/run-undo/journal')
const { withSheetBusy } = await import('../../server/src/lib/sheet-busy')
const { writeRunCells } = await import('../../server/src/lib/run-cells-write')

const undo = async (kind: 'ai' | 'http', runId: string) => {
  const out = await undoRun(uid, kind, runId)
  if ('fail' in out) throw new Error(`undo refused: ${out.message}`)
  return out.ok
}
const refusal = async (kind: 'ai' | 'http', runId: string) => {
  const out = await undoRun(uid, kind, runId)
  assert.ok('fail' in out, 'the undo should have been refused')
  return out.message
}

await ok('prints: empty, ⏳ and text; a cell is restored, already back, or changed since', () => {
  assert.equal(cellPrint(''), PRINT_EMPTY)
  assert.equal(cellPrint(undefined), PRINT_EMPTY)
  assert.equal(cellPrint('⏳ Processing...'), PRINT_RUNNING)
  assert.notEqual(cellPrint('a'), cellPrint('b'))
  assert.notEqual(cellPrint('5'), cellPrint(5))
  assert.equal(undoOutcome('new', [0, 'old', cellPrint('new')]), 'restore')
  assert.equal(undoOutcome('old', [0, 'old', cellPrint('new')]), 'same')
  assert.equal(undoOutcome('edited', [0, 'old', cellPrint('new')]), 'skip')
  // The run's own clear left its ⏳ empty: that empty cell is the run's.
  assert.equal(undoOutcome('', [0, 'old', PRINT_RUNNING]), 'restore')
  // A ⏳ is never a value to go back to.
  assert.equal(undoOutcome('x', [0, '⏳ Processing...', cellPrint('x')]), 'restore')
})

await ok('an AI run: old values back, filled cells empty, an edited cell skipped, a deleted row gone', async () => {
  const sid = sheet([{ N: 'a', Out: 'old0' }, { N: 'b', Out: 'old1' }, { N: 'c' }, { N: 'd' }, { N: 'e', Out: '' }],
    ['N', 'Out'])
  // Rows 0-3 get results, row 4 is left on ⏳ and cleared when the run stops.
  const runId = await run(sid, 'ai', ['Out'], { 0: ['new0'], 1: ['new1'], 2: ['new2'], 3: ['❌ Error: boom'] },
    { status: 'cancelled' })
  assert.deepEqual(cells(sid, 'Out'), ['new0', 'new1', 'new2', '❌ Error: boom', ''])
  edit(sid, 1, 'Out', 'mine')
  db.prepare('DELETE FROM rows WHERE sheet_id = ? AND row_index = 3').run(sid)
  const view = undoViewOf(uid, 'ai', runId)!
  assert.equal(view.can_undo, true)
  assert.equal(view.rows, 5)
  const out = await undo('ai', runId)
  assert.equal(out.state, 'undone')
  assert.deepEqual(cells(sid, 'Out'), ['old0', 'mine', '', ''])
  const j = journal('ai', runId)!
  assert.deepEqual([j.restored, j.skipped, j.gone], [3, 1, 1])
  assert.match(await refusal('ai', runId), /already undone/)
})

await ok('several columns: each cell on its own; the stamp comes back with the main cell', async () => {
  const sid = sheet([{ Url: 'x', Call: '✅ Success', Code: '200' }, { Url: 'y' }], ['Url', 'Call', 'Code'])
  db.prepare(`UPDATE rows SET run_inputs = '{"7":"before"}' WHERE sheet_id = ? AND row_index = 0`).run(sid)
  db.prepare("INSERT INTO run_input_keys (id, user_id, sheet_id, column_name) VALUES (7, ?, ?, 'Call')").run(uid, sid)
  const runId = await run(sid, 'http', ['Call', 'Code'], { 0: ['❌ Failed', '500'], 1: ['✅ Success', '201'] },
    { stamp: '$."7"' })
  edit(sid, 1, 'Code', '418')
  await undo('http', runId)
  assert.deepEqual(cells(sid, 'Call'), ['✅ Success', ''])
  assert.deepEqual(cells(sid, 'Code'), ['200', '418'])
  const stamps = db.prepare('SELECT run_inputs FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sid)
  // Row 0's entry from before the run; row 1 had none (its main cell came back, its Code was edited).
  assert.deepEqual(stamps, ['{"7":"before"}', '{}'])
})

await ok('a rename is followed; a deleted column is never written again, nor one made under its name', async () => {
  const sid = sheet([{ A: 'a0', B: 'b0' }, { A: 'a1', B: 'b1' }], ['A', 'B'])
  const runId = await run(sid, 'http', ['A', 'B'], { 0: ['A0', 'B0'], 1: ['A1', 'B1'] })
  db.transaction(() => {
    db.prepare(`UPDATE rows SET data = json_remove(json_set(data, '$."A2"', json_extract(data, '$.A')), '$.A')
      WHERE sheet_id = ?`).run(sid)
    renameUndoColumn(sid, uid, 'A', 'A2')
    db.prepare(`UPDATE rows SET data = json_remove(data, '$.B') WHERE sheet_id = ?`).run(sid)
    deleteUndoColumn(sid, uid, 'B')
    db.prepare(`UPDATE rows SET data = json_set(data, '$.B', 'B1') WHERE sheet_id = ?`).run(sid)
    db.prepare('UPDATE http_runs SET master_column_name = ? WHERE id = ?').run('A2', runId)
  })()
  await undo('http', runId)
  assert.deepEqual(cells(sid, 'A2'), ['a0', 'a1'])
  assert.deepEqual(cells(sid, 'B'), ['B1', 'B1'])
  assert.equal(journal('http', runId)!.gone, 2)
})

await ok('a rowid SQLite gives a new row after a delete is never taken for the old row', async () => {
  const sid = sheet([{ X: 'keep' }, { X: 'old' }], ['X'])
  const runId = await run(sid, 'http', ['X'], { 1: ['ran'] })
  const rid = db.prepare('SELECT rowid FROM rows WHERE sheet_id = ? AND row_index = 1').pluck().get(sid) as number
  db.prepare('DELETE FROM rows WHERE rowid = ?').run(rid)
  db.prepare('INSERT INTO rows (rowid, id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,1,?)')
    .run(rid, uuid(), sid, uid, JSON.stringify({ X: 'ran' }))
  await undo('http', runId)
  assert.deepEqual(cells(sid, 'X'), ['keep', 'ran'])
  assert.equal(journal('http', runId)!.gone, 1)
})

await ok('a run still going, still clearing, or a newer run filling its column is refused', async () => {
  const sid = sheet([{ Q: '1' }], ['Q'])
  const going = await run(sid, 'http', ['Q'], { 0: ['r'] }, { status: 'paused' })
  assert.match(await refusal('http', going), /still going/)
  db.prepare("UPDATE http_runs SET status = 'cancelled', placeholder_work = 'clearing' WHERE id = ?").run(going)
  assert.match(await refusal('http', going), /being cleared/)
  db.prepare('UPDATE http_runs SET placeholder_work = NULL WHERE id = ?').run(going)
  const newer = await run(sid, 'ai', ['Q'], { 0: ['n'] }, { status: 'running' })
  assert.match(await refusal('http', going), /A run is filling "Q"/)
  db.prepare("UPDATE ai_runs SET status = 'completed' WHERE id = ?").run(newer)
  assert.match(await refusal('http', going), /A newer run wrote "Q" too/)
  await undo('ai', newer)
  assert.equal(undoViewOf(uid, 'http', going)!.can_undo, true)
  assert.match(await refusal('ai', uuid()), /not found/i)
})

await ok('the sheet busy with another job: refused with its reason', async () => {
  const sid = sheet([{ Q: '1' }], ['Q'])
  const runId = await run(sid, 'http', ['Q'], { 0: ['r'] })
  let release!: () => void
  const held = withSheetBusy(sid, 'sorting', () => new Promise<void>(r => { release = r }))
  assert.match(await refusal('http', runId), /busy sorting/)
  release(); await held; await idle(sid)
  await undo('http', runId)
})

await ok('newest first: an older run waits for a newer one on its columns; the menu offers the newest', async () => {
  const sid = sheet([{ V: 'v0' }], ['V'])
  const first = await run(sid, 'http', ['V'], { 0: ['one'] })
  const second = await run(sid, 'http', ['V'], { 0: ['two'] })
  // "Undo last run" offers the newest; once it is undone, the one before.
  assert.equal(lastUndoable(uid, sid, 'V')?.run_id, second)
  // The older one waits: the newer may hold the very values it wrote.
  assert.match(await refusal('http', first), /A newer run wrote "V" too/)
  await undo('http', second)
  assert.deepEqual(cells(sid, 'V'), ['one'])
  assert.equal(lastUndoable(uid, sid, 'V')?.run_id, first)
  await undo('http', first)
  assert.deepEqual(cells(sid, 'V'), ['v0'])
  assert.equal(lastUndoable(uid, sid, 'V'), null)
})

await ok("a list job's words that follow its run move the print: the undo takes them back", async () => {
  const sid = sheet([{ P: '' }], ['P'])
  const runId = await run(sid, 'http', ['P'], { 0: ['➕ Adding 3 rows…'] })
  const rowId = db.prepare('SELECT id FROM rows WHERE sheet_id = ?').pluck().get(sid) as string
  edit(sid, 0, 'P', '✅ 3 rows added to Leads')
  journalFollowUp({ kind: 'http', id: runId }, uid, 'P', [rowId], '✅ 3 rows added to Leads')
  await undo('http', runId)
  assert.deepEqual(cells(sid, 'P'), [''])
  assert.equal(journal('http', runId)!.skipped, 0)
})

await ok("an older list job's ➕ comes back only while its results are still on their way", async () => {
  const sid = sheet([{ P: '➕ Adding 2 rows…' }, { P: '➕ Adding 4 rows…' }], ['P'])
  const runId = await run(sid, 'http', ['P'], { 0: ['✅ Found'], 1: ['✅ Found'] })
  const [r0] = db.prepare('SELECT id FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sid) as string[]
  const older = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,'{}','completed','P')`).run(older, sid, uid)
  db.prepare(`INSERT INTO enrichment_list_items (id,user_id,run_id,source_sheet_id,source_row_id,dest_sheet_id,
    items_json,item_count) VALUES (?,?,?,?,?,?,'[]',2)`).run(uuid(), uid, older, sid, r0, sid)
  await undo('http', runId)
  assert.deepEqual(cells(sid, 'P'), ['➕ Adding 2 rows…', ''])
})

await ok('a run once undone writes nothing again (a late row result is dropped)', async () => {
  const sid = sheet([{ L: 'before' }], ['L'])
  const runId = await run(sid, 'ai', ['L'], { 0: ['ran'] })
  await undo('ai', runId)
  assert.equal(writeRunCells({ kind: 'ai', id: runId }, sid, uid, 0, [['L', 'late']]), false)
  assert.deepEqual(cells(sid, 'L'), ['before'])
})

await ok('a value SQLite stores differently (a lone surrogate half) is still the run\'s own', async () => {
  const sid = sheet([{ S: 'kept' }], ['S'])
  const odd = `abc${String.fromCharCode(0xd83d)}`
  const runId = await run(sid, 'http', ['S'], { 0: [odd] })
  const out = await undo('http', runId)
  assert.deepEqual([out.restored, out.skipped], [1, 0])
  assert.deepEqual(cells(sid, 'S'), ['kept'])
})

await ok('a row SQLite cannot write back is skipped; the undo goes on', async () => {
  const sid = sheet([{ B: 'b0' }, { B: 'b1' }], ['B'])
  const runId = await run(sid, 'http', ['B'], {}, { status: 'cancelled' })
  db.prepare(`UPDATE rows SET data = '{"B": broken' WHERE sheet_id = ? AND row_index = 0`).run(sid)
  const out = await undo('http', runId)
  assert.equal(out.state, 'undone')
  assert.deepEqual([out.restored, out.skipped], [1, 1])
  assert.equal(db.prepare(`SELECT json_extract(data, '$.B') FROM rows WHERE sheet_id = ? AND row_index = 1`)
    .pluck().get(sid), 'b1')
})

await ok('an undone journal drops its rows; its counts stay', async () => {
  const sid = sheet([{ Z: 'z' }], ['Z'])
  const runId = await run(sid, 'http', ['Z'], { 0: ['ran'] })
  await undo('http', runId)
  const j = journal('http', runId)!
  for (let i = 0; i < 50 && journalRows(j.id) > 0; i++) await new Promise(r => setTimeout(r, 10))
  assert.equal(journalRows(j.id), 0)
  assert.equal(journal('http', runId)!.restored, 1)
})

done()
