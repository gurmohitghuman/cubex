// A run's ⏳ clear (lib/placeholder-cells.ts) tells the columns reading its cells only of the rows where that can
// change what they worked out: every reader kind reads a ⏳ as empty (readers-read-placeholder-empty.test.ts), so a
// cell the journal says read as empty before the run (none, '', a ⏳ or a list job's words) and that the clear
// empties is told to none. A cell put back is, and so is one the journal has no slot for, as a span of the slice's
// told rows with a mark per reader (lib/derived-spans.ts), never a queued row. A run's first try on a new column
// tells none, and its slices are as big as the journal lookups allow; when cells put back come thick, with three
// readers, they still are, one span each. The sheet's data_version moves after each slice, so open grids lose the
// ⏳ as the clear goes. A column started while the clear goes (nothing holds it off) fills rows ahead of it from the
// ⏳, and hears of the cells put back after it started. The readers end right.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
const { db, uid, ok, done, idle, sheet, cells } = undoKit('run-clear-told')
const { clearProcessingPlaceholders, seedProcessingPlaceholders, PLACEHOLDER } =
  await import('../../server/src/lib/placeholder-cells')
const { startFormulaColumn } = await import('../../server/src/services/formula-column')
const { derivedFollowTick } = await import('../../server/src/services/derived-follow')
const { entryFor } = await import('../../server/src/services/autorun-entry')
const { LIST_MARK } = await import('../../server/src/lib/run-markers')
const { PLACEHOLDER_CLEAR_BACK_ROWS } = await import('../../server/src/lib/constants')
console.error = () => {}

const formula = async (sid: string, column: string, f: string) => {
  assert.ok('ok' in await startFormulaColumn(uid, sid, { column, formula: f }), column)
  await idle(sid)
}
// An HTTP run on `columns` over every row, its journal keeping what they held, then cancelled.
async function seededRun(sid: string, columns: string[]) {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,placeholder_work)
    VALUES (?,?,?,'{}','cancelled',?,'clearing')`).run(id, sid, uid, columns[0])
  const last = db.prepare('SELECT MAX(row_index) FROM rows WHERE sheet_id = ?').pluck().get(sid) as number
  await seedProcessingPlaceholders({ run: { kind: 'http', id }, sheetId: sid, userId: uid, columns, targets: null,
    lastRow: last, live: () => true })
  return { kind: 'http' as const, id }
}
const held = db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND instr(data, ?) > 0').pluck()
const version = db.prepare('SELECT data_version FROM sheets WHERE id = ?').pluck()
// The clear, watched: rows per slice, and how far data_version moved by the end of each. `then` runs after each.
// Then the run lets its columns go, as its clear's end does (lib/run-placeholders.ts): the readers wait for that.
async function clear(sid: string, columns: string[], run: { kind: 'http'; id: string }, then?: () => void) {
  const sizes: number[] = [], moved: number[] = []
  const v0 = version.get(sid) as number
  let rowsLeft = held.get(sid, PLACEHOLDER) as number
  await clearProcessingPlaceholders(sid, uid, columns, () => {
    const now = held.get(sid, PLACEHOLDER) as number
    sizes.push(rowsLeft - now)
    rowsLeft = now
    moved.push((version.get(sid) as number) - v0)
    then?.()
  }, run)
  db.prepare('UPDATE http_runs SET placeholder_work = NULL WHERE id = ?').run(run.id)
  return { sizes, moved }
}
const entry = (sid: string, column: string) => entryFor(sid, uid, column)!.id
// The row indexes queued for a column, and those told it by span.
const queuedRows = (sid: string, column: string) => (db.prepare(`SELECT r.row_index FROM autorun_pending p
  JOIN rows r ON r.id = p.row_id WHERE p.autorun_id = ? ORDER BY r.row_index`).pluck()
  .all(entry(sid, column)) as number[])
const toldRows = (sid: string, column: string) => (db.prepare(`SELECT r.row_index FROM derived_span_marks m
    JOIN derived_spans s ON s.id = m.span_id, json_each(s.rowids) j JOIN rows r ON r.rowid = j.value
  WHERE m.autorun_id = ? ORDER BY r.row_index`).pluck().all(entry(sid, column)) as number[])
const marks = (sid: string, column: string) => db.prepare(
  'SELECT COUNT(*) FROM derived_span_marks WHERE autorun_id = ?').pluck().get(entry(sid, column)) as number
const follow = async (sid: string, column: string) => {
  for (let n = 0; marks(sid, column) > 0 && n < 50; n++) await derivedFollowTick(entryFor(sid, uid, column)!)
  assert.equal(marks(sid, column), 0, `${column} worked out every span`)
}
// With readers, each cell put back costs two journal lookups.
const readSlice = (k: number) => Math.floor(PLACEHOLDER_CLEAR_BACK_ROWS / (1 + 2 * k))

await ok('a run\'s first try on a new column: none told, slices as big as the journal allows, grids follow',
  async () => {
  const n = readSlice(1) * 2 + 7
  const sid = sheet(Array.from({ length: n }, (_, i) => ({ Name: `n${i}` })), ['Name', 'Answer'])
  for (let k = 0; k < 3; k++) await formula(sid, `F${k}`, `{{Answer}} + "-${k}"`)
  const run = await seededRun(sid, ['Answer'])
  const { sizes, moved } = await clear(sid, ['Answer'], run)
  assert.deepEqual(sizes, [readSlice(1), readSlice(1), 7], 'rows per slice')
  assert.deepEqual(moved, [1, 2, 3], 'data_version moved after each slice')
  for (let k = 0; k < 3; k++) {
    assert.deepEqual([queuedRows(sid, `F${k}`), toldRows(sid, `F${k}`)], [[], []], `nothing told F${k}`)
    assert.deepEqual(new Set(cells(sid, `F${k}`)), new Set([`-${k}`]), `F${k} already right`)
  }
  assert.deepEqual(new Set(cells(sid, 'Answer')), new Set(['']))
})

await ok('told: a cell put back and one the journal has no slot for; not: none, \'\', a ⏳, a list job\'s words',
  async () => {
    // Row i%5: 0 an earlier answer, 1 '', 2 no cell, 3 a ⏳ an older run left, 4 a list job's words.
    const before = (i: number) => [`old ${i}`, '', undefined, PLACEHOLDER, `${LIST_MARK} Listing...`][i % 5]
    const sid = sheet(Array.from({ length: 20 }, (_, i) => ({ Name: `n${i}`, Answer: before(i) })),
      ['Name', 'Answer', 'Loose'])
    await formula(sid, 'F', '{{Answer}} + "!"')
    const run = await seededRun(sid, ['Answer'])
    // Saved again while the run goes: it reads the ⏳ as empty everywhere. A ⏳ the journal has no slot for, too.
    await formula(sid, 'F', '"" + {{Answer}} + "!"')
    db.prepare(`UPDATE rows SET data = json_set(data, '$.Loose', ?) WHERE sheet_id = ? AND row_index IN (6, 7)`)
      .run(PLACEHOLDER, sid)
    await clear(sid, ['Answer', 'Loose'], run)
    assert.deepEqual(toldRows(sid, 'F'), [0, 5, 6, 7, 10, 15], 'rows told')
    assert.deepEqual(queuedRows(sid, 'F'), [], 'none queued')
    await follow(sid, 'F')
    const want = Array.from({ length: 20 }, (_, i) => (i % 5 === 0 ? `old ${i}` : ''))
    assert.deepEqual(cells(sid, 'Answer'), want)
    assert.deepEqual(cells(sid, 'F'), want.map(a => `${a}!`), 'F ends right')
  })

await ok('cells put back come thick, three readers: slices as big as the journal allows, one span each', async () => {
  // Rows past `thin` held earlier answers: the first slice tells 100 rows, the others every row.
  const share = 500
  const thin = readSlice(1) - 100
  const n = readSlice(1) + share + 10
  const sid = sheet(Array.from({ length: n }, (_, i) => ({ Name: `n${i}`,
    ...(i >= thin ? { Answer: `old ${i}` } : {}) })), ['Name', 'Answer'])
  for (let k = 0; k < 3; k++) await formula(sid, `F${k}`, `{{Answer}} + "-${k}"`)
  const run = await seededRun(sid, ['Answer'])
  const { sizes, moved } = await clear(sid, ['Answer'], run)
  assert.deepEqual(sizes, [readSlice(1), n - readSlice(1)], 'rows per slice')
  assert.deepEqual(moved, [1, 2])
  const spans = db.prepare('SELECT COUNT(*) FROM derived_spans WHERE sheet_id = ?').pluck().get(sid)
  assert.equal(spans, 2, 'one span a slice that told rows')
  for (let k = 0; k < 3; k++) {
    assert.equal(toldRows(sid, `F${k}`).length, n - thin, `every row put back told F${k}`)
    assert.deepEqual(queuedRows(sid, `F${k}`), [], `none queued for F${k}`)
  }
  for (let k = 0; k < 3; k++) {
    await follow(sid, `F${k}`)
    assert.deepEqual(cells(sid, `F${k}`), Array.from({ length: n }, (_, i) => `${i >= thin ? `old ${i}` : ''}-${k}`))
  }
  assert.equal(db.prepare('SELECT COUNT(*) FROM derived_spans WHERE sheet_id = ?').pluck().get(sid), 0,
    'a span goes with its last mark')
})

await ok('a formula started while the clear goes, none reading the cells before: told of the cells put back after',
  async () => {
    // Seven columns put back: slices of PLACEHOLDER_CLEAR_BACK_ROWS / 8 rows, so the formula's fill, started after
    // the first, runs ahead of the clear and works "!" out of the ⏳ there.
    const columns = ['A', 'B', 'C', 'D', 'E', 'G', 'H']
    const n = 20_000
    const sid = sheet(Array.from({ length: n }, (_, i) => ({ Name: `n${i}`,
      ...Object.fromEntries(columns.map(c => [c, `${c}${i}`])) })), ['Name', ...columns])
    const run = await seededRun(sid, columns)
    let started: Promise<object> | undefined
    const { sizes } = await clear(sid, columns, run, () => {
      started ??= startFormulaColumn(uid, sid, { column: 'F', formula: '{{A}} + "!"' })
    })
    assert.ok(started && 'ok' in await started, 'F started')
    // Unread, a slice holds BACK / 8 rows; once F reads the cells, BACK / 15 (a second lookup per cell), every row
    // told.
    const [alone, read] = [Math.floor(PLACEHOLDER_CLEAR_BACK_ROWS / 8), Math.floor(PLACEHOLDER_CLEAR_BACK_ROWS / 15)]
    const k = sizes.indexOf(read)
    assert.ok(k > 0, `the slices once F read the cells: ${sizes.join(', ')}`)
    assert.deepEqual(sizes.slice(0, k), Array(k).fill(alone), 'rows per slice before F read the cells')
    assert.ok(sizes.slice(k).every(r => r <= read), `rows per slice once F read the cells: ${sizes.slice(k)}`)
    await idle(sid)
    await follow(sid, 'F')
    assert.deepEqual(cells(sid, 'A'), Array.from({ length: n }, (_, i) => `A${i}`))
    const wrong = cells(sid, 'F').filter((f, i) => f !== `A${i}!`).length
    assert.equal(wrong, 0, `F wrong on ${wrong} rows: the clear never told it of the cells it put back`)
  })

done()
