// A stopped run's ⏳ clear tells the formula reading its column the rows it put back as spans
// (lib/derived-spans.ts, span-kit.ts has the scene), and the formula works them out once the clear has ended
// (services/derived-follow.ts). Exactly those rows, whatever happens in between: the formula, and a formula
// reading it, end right for what the cells hold then, and no auto-run that costs hears of the clear. Here: the
// run's real end; a person's edit in a row not told stays; a row edited while the clear goes; the formula waits
// for the clear's end; a sort between the clear and the follow; rows deleted or sent to the trash after the
// clear, one restored before the formula's turn; long text in the formula's cells, a span worked out in slices the
// read cap ends; long answers, slices that end early; a second run on the column before the formula caught up,
// waited for at its ⏳, so no wrong value shows; and a ⏳ a person typed, with no run holding the column, not
// waited for.
import assert from 'node:assert/strict'
import { spanKit, fOf } from './span-kit'
import endMod from '../../server/src/lib/run-placeholders'
import sortMod from '../../server/src/services/sheet-sort'
import trashMod from '../../server/src/services/trash-rows'
import restoreMod from '../../server/src/services/trash-restore'
import storeMod from '../../server/src/lib/trash/store'
import constMod from '../../server/src/lib/constants'
import followMod from '../../server/src/services/derived-follow'
import entryMod from '../../server/src/services/autorun-entry'
import cellsMod from '../../server/src/lib/placeholder-cells'
const { clearRunPlaceholders } = endMod as typeof import('../../server/src/lib/run-placeholders')
const { physicalSortSheet } = sortMod as typeof import('../../server/src/services/sheet-sort')
const { deleteRowsToTrash } = trashMod as typeof import('../../server/src/services/trash-rows')
const { restoreRows } = restoreMod as typeof import('../../server/src/services/trash-restore')
const { setTrashDays, getTrashDays } = storeMod as typeof import('../../server/src/lib/trash/store')
const { PLACEHOLDER_CLEAR_BACK_ROWS, DERIVED_SLICE_CHARS } = constMod as typeof import('../../server/src/lib/constants')
const { derivedFollowTick } = followMod as typeof import('../../server/src/services/derived-follow')
const { loadEntry } = entryMod as typeof import('../../server/src/services/autorun-entry')
const { PLACEHOLDER } = cellsMod as typeof import('../../server/src/lib/placeholder-cells')
const k = spanKit('derived-span-exact')
const { db, uid, ok, done, idle, cells, entry, runOn, scene, clear, write, told, queued, spans, progress, follow } = k
console.error = () => {}

// The clear's rows a slice: one column put back, read (two journal lookups a cell).
const READ = Math.floor(PLACEHOLDER_CLEAR_BACK_ROWS / 3)
const range = (n: number) => Array.from({ length: n }, (_, i) => i)
const tick = (sid: string, column: string) => derivedFollowTick(loadEntry(entry(sid, column))!)
const version = (sid: string) => db.prepare('SELECT data_version FROM sheets WHERE id = ?').pluck().get(sid) as number

await ok('a run cancelled, its real end: F hears by span, F then F2 follow, no paid auto-run hears', async () => {
  const n = READ * 2 + 5
  const { sid, run, paid } = await scene(n)
  await clearRunPlaceholders('http', run.id)
  assert.equal(db.prepare('SELECT placeholder_work FROM http_runs WHERE id = ?').pluck().get(run.id), null)
  assert.deepEqual([spans(sid), progress(sid, 'F'), progress(sid, 'F2')], [3, [0, 0, 0], []],
    'a span a slice; F marked, F2 (reading F) not')
  assert.deepEqual(told(sid, 'F'), range(n), 'every row put back told')
  assert.deepEqual([queued(sid, entry(sid, 'F')), ...paid.map(p => queued(sid, p))], [[], [], []], 'none queued')
  await follow(sid)
  k.right(sid, paid)
})

await ok('a person\'s edit of F in a row not told stays; rows told follow', async () => {
  // Rows 3 and 7 read as empty before the run: the clear empties them and tells no one.
  const { sid, run, paid } = await scene(8, { answer: i => (i % 4 === 3 ? '' : `Old ${i}`) })
  await clear(sid, run)
  assert.deepEqual(told(sid, 'F'), [0, 1, 2, 4, 5, 6])
  write(sid, 3, [['F', 'mine']])
  await follow(sid)
  const f = cells(sid, 'Answer').map((a, i) => (i === 3 ? 'mine' : fOf(a)))
  k.right(sid, paid, { f, loud: [[], [3]] })
})

await ok('rows edited while the clear goes, one cleared and one still ⏳: F follows the edits', async () => {
  const n = READ * 2 + 5
  const { sid, run, paid } = await scene(n)
  const slices = await clear(sid, run, slice => {
    if (slice !== 1) return
    write(sid, READ - 1, [['Answer', 'Typed A']])
    write(sid, n - 1, [['Answer', 'Typed B']])
  })
  assert.equal(slices, 3)
  assert.deepEqual(told(sid, 'F'), range(n - 1), 'the row typed over its ⏳ was not cleared, nor told')
  await follow(sid)
  assert.deepEqual([cells(sid, 'F')[READ - 1], cells(sid, 'F')[n - 1]], ['has Typed A', 'has Typed B'])
  k.right(sid, paid, { loud: [[READ - 1, n - 1], [READ - 1, n - 1]] })
})

await ok('F waits for the clear to end: a tick while it goes works out nothing', async () => {
  const { sid, run, paid } = await scene(READ + 5)
  const seen: unknown[] = []
  await clear(sid, run, async slice => {
    if (slice !== 1) return
    await tick(sid, 'F')
    seen.push(progress(sid, 'F').every(d => d === 0), cells(sid, 'F').every(c => c === 'empty'))
  })
  assert.deepEqual(seen, [true, true], 'no span started while the clear went')
  await follow(sid)
  k.right(sid, paid)
})

await ok('a sort between the clear and the follow: the spans hold rowids, so F works out the rows told', async () => {
  const { sid, run, paid } = await scene(12, { answer: i => (i % 3 === 2 ? '' : `Old ${i}`) })
  await clear(sid, run)
  const before = cells(sid, 'Name').filter((_, i) => told(sid, 'F').includes(i))
  const out = await physicalSortSheet(sid, uid, 'Name', 'desc')
  assert.ok('ok' in out, JSON.stringify(out))
  await idle(sid)
  assert.deepEqual(cells(sid, 'Name').filter((_, i) => told(sid, 'F').includes(i)).reverse(), before)
  await follow(sid)
  k.right(sid, paid)
})

await ok('rows deleted, and sent to the trash, after the clear are passed over; one restored is worked out',
  async () => {
  const { sid, run, paid } = await scene(10)
  await clear(sid, run)
  const days = getTrashDays(uid)
  setTrashDays(uid, 0)
  try {
    assert.equal(deleteRowsToTrash(sid, uid, 'grid', { indexes: [1] }).trashId, null, 'deleted, not kept')
  } finally { setTrashDays(uid, days) }
  const trashed = deleteRowsToTrash(sid, uid, 'grid', { indexes: [3, 7] })
  assert.ok(trashed.trashId !== null)
  const seq = db.prepare(`SELECT seq FROM trash_rows WHERE item_id = ? AND json_extract(data, '$.Name') = ?`)
    .pluck().get(trashed.trashId, 'n00003') as number
  const back = await restoreRows(uid, trashed.trashId!, [seq])
  assert.ok('ok' in back, JSON.stringify(back))
  await idle(sid)
  assert.deepEqual(cells(sid, 'Name').length, 8)
  assert.equal(cells(sid, 'Name')[2], 'n00003', 'row 3 is back at its place')
  await follow(sid)
  // A restore queues its rows for F and F2 as any write (lib/trash/restore-rows.ts), so F2's answer for row 3
  // reaches Enriched: the restore's doing, not the clear's.
  k.right(sid, paid, { loud: [[], [3]] })
})

// Cells of `size` characters: a follow slice reads `cap` rows, then stops at the read cap (DERIVED_SLICE_CHARS).
const SIZE = 100_000
const CAP = Math.ceil(DERIVED_SLICE_CHARS / SIZE)

await ok('long text in F\'s cells: a span worked out in slices the read cap ends, rows gone at the cap passed over',
  async () => {
  // Answer is short, so working the rows out is quick: the read cap ends the slice, not the time it may take.
  const n = CAP + 5
  const { sid, run, paid } = await scene(n)
  await clear(sid, run)
  assert.equal(spans(sid), 1)
  db.prepare("UPDATE rows SET data = json_set(data, '$.F', ?) WHERE sheet_id = ?").run('x'.repeat(SIZE), sid)
  // The cap's last row, and the span's last.
  for (const i of [n - 1, CAP - 1]) deleteRowsToTrash(sid, uid, 'grid', { indexes: [i] })
  const v = version(sid)
  await follow(sid, ['F'])
  assert.equal(version(sid) - v, 2, 'two slices: the read cap ended the first')
  await follow(sid)
  k.right(sid, paid)
})

await ok('long answers: slices end early (the read cap, or the time one may take), and F ends right', async () => {
  const n = CAP + 5
  const { sid, run, paid } = await scene(n, { answer: i => `${i} ${'x'.repeat(SIZE)}` })
  await clear(sid, run)
  deleteRowsToTrash(sid, uid, 'grid', { indexes: [n - 1] })
  const v = version(sid)
  await follow(sid, ['F'])
  assert.ok(version(sid) - v >= 2, 'more than one slice')
  await follow(sid)
  k.right(sid, paid)
})

await ok('a second run on Answer before F caught up: F waits at its ⏳, no wrong value shows, both end right',
  async () => {
  // F and F2 were right before the first run: the clear tells every row, and nothing changes.
  const { sid, run, paid } = await scene(10, { before: true })
  await clear(sid, run)
  const again = await runOn(sid, { going: true, targets: [5, 6] })
  for (let t = 0; t < 2; t++) {
    await tick(sid, 'F')
    assert.deepEqual(progress(sid, 'F'), [5], 'F works rows 0 to 4 out, and waits at row 5')
    assert.deepEqual([cells(sid, 'F')[5], cells(sid, 'F2')[5]], ['has Old 5', 'has Old 5!'], 'no ⏳ read as empty')
  }
  write(sid, 5, [['Answer', 'New 5']], again)
  write(sid, 6, [['Answer', 'New 6']], again)
  db.prepare("UPDATE http_runs SET status = 'completed' WHERE id = ?").run(again.id)
  await follow(sid)
  k.right(sid, paid, { loud: [[5, 6], [5, 6]] })
})

await ok('the ⏳ text typed into Answer, no run holding it: F works that row out (as empty), not waiting there',
  async () => {
  const { sid, run, paid } = await scene(10)
  await clear(sid, run)
  write(sid, 4, [['Answer', PLACEHOLDER]])
  await tick(sid, 'F')
  assert.deepEqual(progress(sid, 'F'), [], 'F went past row 4 and finished its span')
  await follow(sid)
  const f = cells(sid, 'Answer').map(a => (a === PLACEHOLDER ? 'empty' : fOf(a)))
  assert.equal(f[4], 'empty')
  // Hook hears of the person's edit; F's answer for row 4 was 'empty' already, so F2's doesn't change.
  k.right(sid, paid, { f, loud: [[4], []] })
})

done()
