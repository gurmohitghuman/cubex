// What happens to the spans a stopped run's ⏳ clear told (lib/derived-spans.ts, span-kit.ts has the scene) while
// the formulas reading the column catch up. A reader deleted takes its marks, and the span stays for the others;
// a reader turned off keeps its marks, as it keeps its queued rows, and turned on again works every row out and
// ends right; a CSV replace, a sheet's purge and a queue dropped in slices take the sheet's spans and no other
// sheet's; after a restart nothing kicks the readers, and the auto-run sweep finishes from where each got; the
// run undone while spans are left ends right with no paid auto-run hearing of it; and nothing is locked while
// they catch up: a reader renamed, saved with a new formula or deleted, the run undone, and its column run again.
import assert from 'node:assert/strict'
import { spanKit } from './span-kit'
import formulaMod from '../../server/src/services/formula-column'
import formulaRecMod from '../../server/src/lib/formula-columns'
import deleteMod from '../../server/src/services/column-delete'
import renameMod from '../../server/src/services/column-rename'
import undoMod from '../../server/src/services/run-undo'
import importMod from '../../server/src/services/csv-import'
import parseMod from '../../server/src/lib/csv-import-parse'
import sheetsMod from '../../server/src/services/trash-sheets'
import purgeMod from '../../server/src/services/trash-purge'
import markMod from '../../server/src/lib/autorun-mark'
import spansMod from '../../server/src/lib/derived-spans'
import endMod from '../../server/src/lib/run-placeholders'
import lockMod from '../../server/src/lib/run-locked-columns'
import busyMod from '../../server/src/lib/sheet-busy'
import loopMod from '../../server/src/services/autorun-loop'
import followMod from '../../server/src/services/derived-follow'
import entryMod from '../../server/src/services/autorun-entry'
const { startFormulaColumn, setFormulaColumnAutorun } =
  formulaMod as typeof import('../../server/src/services/formula-column')
const { formulaColumnFor } = formulaRecMod as typeof import('../../server/src/lib/formula-columns')
const { deleteSheetColumn } = deleteMod as typeof import('../../server/src/services/column-delete')
const { renameSheetColumn } = renameMod as typeof import('../../server/src/services/column-rename')
const { undoRun } = undoMod as typeof import('../../server/src/services/run-undo')
const { importCsv } = importMod as typeof import('../../server/src/services/csv-import')
const { scanCsvText } = parseMod as typeof import('../../server/src/lib/csv-import-parse')
const { trashSheet } = sheetsMod as typeof import('../../server/src/services/trash-sheets')
const { purgeTrashItems } = purgeMod as typeof import('../../server/src/services/trash-purge')
const { autorunDropPending, derivedReaderIds } = markMod as typeof import('../../server/src/lib/autorun-mark')
const { tellDerivedSpan } = spansMod as typeof import('../../server/src/lib/derived-spans')
const { clearRunPlaceholders } = endMod as typeof import('../../server/src/lib/run-placeholders')
const { getLockedRunColumns } = lockMod as typeof import('../../server/src/lib/run-locked-columns')
const { sheetBusyWith } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { autorunTick } = loopMod as typeof import('../../server/src/services/autorun-loop')
const { derivedFollowTick } = followMod as typeof import('../../server/src/services/derived-follow')
const { loadEntry } = entryMod as typeof import('../../server/src/services/autorun-entry')
const k = spanKit('derived-span-life')
const { db, uid, tid, ok, done, idle, cells, entry, formula, runOn, scene, clear, write, queued, marks, spans,
  progress, follow } = k
console.error = () => {}

const tick = (sid: string, column: string) => derivedFollowTick(loadEntry(entry(sid, column))!)
const range = (n: number) => Array.from({ length: n }, (_, i) => i)
// A second run on rows `targets` of Answer, clearing: F, once the first clear has ended, works rows out up to its
// first ⏳ and waits there until that clear finishes.
async function waitingAt(sid: string, targets: number[]) {
  const again = await runOn(sid, { targets })
  await tick(sid, 'F')
  assert.deepEqual(progress(sid, 'F'), [targets[0]], 'F waits at the second run\'s first ⏳')
  return again
}
// That run's worker writes its answers, and it ends.
function answered(sid: string, again: { kind: 'http'; id: string }, rows: number[]) {
  for (const i of rows) write(sid, i, [['Answer', `New ${i}`]], again)
  db.prepare("UPDATE http_runs SET status = 'completed' WHERE id = ?").run(again.id)
}

await ok('F deleted while it waits mid-span: its mark goes, the span stays for G, which works it out', async () => {
  const { sid, run } = await scene(10, { before: true })
  await formula(sid, 'G', '{{Answer}} + "?"')
  await clear(sid, run)
  assert.deepEqual([spans(sid), progress(sid, 'G')], [1, [0]])
  const again = await waitingAt(sid, [5])
  const out = await deleteSheetColumn(sid, uid, 'F')
  assert.ok('ok' in out, JSON.stringify(out))
  assert.deepEqual([spans(sid), marks(sid), progress(sid, 'G')], [1, 1, [0]], 'G\'s mark and the span stay')
  await clearRunPlaceholders('http', again.id)
  await follow(sid, ['G'])
  assert.deepEqual(cells(sid, 'G'), cells(sid, 'Answer').map(a => `${a}?`))
  assert.deepEqual([spans(sid), marks(sid)], [0, 0], 'the span went with G\'s mark')
})

await ok('F turned off keeps its marks, as its queue; turned on, it works every row out and ends right',
  async () => {
  const { sid, run, paid } = await scene(10)
  await clear(sid, run)
  const rec = () => formulaColumnFor(sid, uid, 'F')!
  assert.ok('ok' in await setFormulaColumnAutorun(uid, sid, rec(), false))
  write(sid, 2, [['Answer', 'Typed']])
  await tick(sid, 'F')
  await autorunTick(entry(sid, 'F'))
  assert.deepEqual([progress(sid, 'F'), cells(sid, 'F').every(c => c === 'empty')], [[0], true],
    'off, it works nothing out, and its mark stays')
  assert.ok('ok' in await setFormulaColumnAutorun(uid, sid, rec(), true))
  await idle(sid)
  await follow(sid)
  // The person's edit reaches Hook; turning F on works every row out again, F2 follows, and that reaches Enriched.
  k.right(sid, paid, { loud: [[2], range(10)] })
})

await ok('a CSV replace takes the sheet\'s spans; so do a dropped queue, in slices, and a sheet\'s purge',
  async () => {
  const { sid, run } = await scene(6)
  await clear(sid, run)
  assert.deepEqual([spans(sid), marks(sid)], [1, 1])
  const out = await importCsv(sid, uid, await scanCsvText('Name,Answer\nx,1\ny,2\n'), true)
  assert.ok('ok' in out, JSON.stringify(out))
  await idle(sid)
  assert.deepEqual([spans(sid), marks(sid)], [0, 0], 'the replace took them')
  // Thirty spans told to F and G on each of two sheets: 60 marks a sheet, past DERIVED_SPAN_DROP_MARKS a slice.
  const many = async () => {
    const s = await scene(4)
    await formula(s.sid, 'G', '{{Answer}} + "?"')
    const rowids = db.prepare('SELECT rowid FROM rows WHERE sheet_id = ? ORDER BY rowid').pluck().all(s.sid) as
      number[]
    db.transaction(() => {
      const readers = derivedReaderIds(s.sid, uid, ['Answer'])
      for (let i = 0; i < 30; i++) tellDerivedSpan(s.sid, uid, readers, rowids, s.run)
    }).immediate()
    assert.deepEqual([spans(s.sid), marks(s.sid)], [30, 60])
    return s.sid
  }
  const [a, b, c] = [await many(), await many(), await many()]
  await autorunDropPending(a, uid)
  assert.deepEqual([spans(a), marks(a), spans(b), marks(b)], [0, 0, 30, 60], 'a\'s queue dropped, b\'s kept')
  assert.ok('ok' in trashSheet(uid, tid, b))
  const item = db.prepare("SELECT id FROM trash_items WHERE sheet_id = ? AND kind = 'sheet'").pluck().get(b) as number
  purgeTrashItems(uid, [item])
  for (let i = 0; i < 500 && db.prepare('SELECT 1 FROM trash_items WHERE id = ?').get(item); i++) {
    await new Promise(r => setTimeout(r, 10))
  }
  assert.deepEqual([spans(b), marks(b), spans(c), marks(c)], [0, 0, 30, 60], 'b\'s purge took its spans, not c\'s')
})

await ok('after a restart nothing kicks F: the auto-run sweep finishes from where each mark got', async () => {
  const { sid, run, paid } = await scene(10, { before: true })
  await clear(sid, run)
  const again = await waitingAt(sid, [5])
  // The second run's worker fails, and its clear puts row 5's answer back: one more span for F.
  db.prepare("UPDATE http_runs SET status = 'failed', placeholder_work = 'clearing' WHERE id = ?").run(again.id)
  await clearRunPlaceholders('http', again.id)
  assert.deepEqual(progress(sid, 'F'), [5, 0], 'F got 5 rows into the first span; the second is new')
  await follow(sid, ['F', 'F2'], autorunTick)
  k.right(sid, paid)
})

await ok('the run undone while F has spans left: F ends right, no paid auto-run hears', async () => {
  const { sid, run, paid } = await scene(10)
  // The run answered rows 0 and 1 before it was stopped: F and F2 followed, and the paid auto-runs heard.
  for (const i of [0, 1]) write(sid, i, [['Answer', `New ${i}`]], run)
  await follow(sid)
  db.prepare('DELETE FROM autorun_pending').run()
  await clear(sid, run)
  assert.deepEqual(progress(sid, 'F'), [0])
  const out = await undoRun(uid, 'http', run.id)
  assert.ok('ok' in out, JSON.stringify(out))
  await idle(sid)
  assert.deepEqual(cells(sid, 'Answer'), range(10).map(i => `Old ${i}`), 'every answer as before the run')
  await follow(sid)
  k.right(sid, paid)
})

await ok('nothing is locked while the readers catch up: F renamed, saved anew, G deleted, the run undone, '
  + 'Answer run again', async () => {
  const { sid, run, paid } = await scene(10)
  await formula(sid, 'G', '{{Answer}} + "?"')
  write(sid, 0, [['Answer', 'New 0']], run)
  db.prepare('DELETE FROM autorun_pending').run()
  await clear(sid, run)
  assert.deepEqual([progress(sid, 'F'), progress(sid, 'G')], [[0], [0]])
  assert.deepEqual([[...getLockedRunColumns(sid, uid, { clearing: true })], sheetBusyWith(sid)], [[], null],
    'no run holds Answer, and the sheet is free')
  const renamed = await renameSheetColumn(sid, uid, 'F', 'Fx')
  assert.ok('ok' in renamed, JSON.stringify(renamed))
  const saved = await startFormulaColumn(uid, sid,
    { column: 'Fx', formula: '{{Answer}} ? "got " + {{Answer}} : "none"' })
  assert.ok('ok' in saved, JSON.stringify(saved))
  await idle(sid)
  const gone = await deleteSheetColumn(sid, uid, 'G')
  assert.ok('ok' in gone, JSON.stringify(gone))
  assert.deepEqual(progress(sid, 'Fx'), [0], 'Fx keeps its mark through the rename and the save')
  const undone = await undoRun(uid, 'http', run.id)
  assert.ok('ok' in undone, JSON.stringify(undone))
  await idle(sid)
  const again = await runOn(sid, { going: true, targets: [3] })
  answered(sid, again, [3])
  await follow(sid, ['Fx', 'F2'])
  const fx = cells(sid, 'Answer').map(a => (a ? `got ${a}` : 'none'))
  assert.deepEqual([cells(sid, 'Fx'), cells(sid, 'F2')], [fx, fx.map(v => `${v}!`)])
  assert.deepEqual(cells(sid, 'Answer')[3], 'New 3')
  assert.deepEqual([spans(sid), marks(sid)], [0, 0])
  // Hook hears of the second run's answer; Fx saved anew works every row out, and F2's new answers reach Enriched.
  assert.deepEqual(paid.map(p => queued(sid, p)), [[3], range(10)])
})

done()
