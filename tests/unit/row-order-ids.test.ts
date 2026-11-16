// The rowids of a sheet's rows as lib/row-order.ts reads them (sheetRowIds): ascending and each once, for every
// row, the rows up to one, and a list of targets, past one page of 50,000, on a sheet never sorted (its pages come
// in order and are laid end to end) and on a sorted one (row order far from storage order: each page is sorted,
// then the pages are merged). A bulk writer's slice that ends early (lib/placeholder-cells.ts) relies on it: the
// rows it took are the ones before a given row, and the next slice starts after them.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'
const { db, uid, ok, done, sheet } = undoKit('row-order-ids')
const { sheetRowIds } = await import('../../server/src/lib/row-order')

// Three pages, the last a short one, so a merge round carries one over.
const N = 120_001

// A sheet of N rows, row i at the row index `at` gives (row 0 at 0).
function sheetOf(at: (i: number) => number): string {
  const sid = sheet([{ Name: 'n0' }], ['Name'])
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 1; i < N; i++) ins.run(uuid(), sid, uid, at(i), JSON.stringify({ Name: `n${i}` }))
  }).immediate()
  return sid
}
const rowids = (sid: string, where = '', ...args: unknown[]) => db.prepare(`SELECT rowid FROM rows
  WHERE sheet_id = ?${where} ORDER BY rowid`).pluck().all(sid, ...args) as number[]
// The ids read against the rows' rowids, ascending: the first place they differ (a diff of the whole would be huge).
function same(got: Float64Array, want: number[], what: string) {
  assert.equal(got.length, want.length, `${what}: ${got.length} ids for ${want.length} rows`)
  const at = want.findIndex((id, i) => got[i] !== id)
  assert.equal(at, -1, `${what}: ${got[at]} at ${at} where ${want[at]} goes (out of order, or one twice)`)
}

const sheets: Array<[string, (i: number) => number]> = [
  ['a sheet never sorted', i => i],
  // A step coprime with N: every index from 1 to N - 1 once, far from storage order.
  ['a sorted sheet', i => (i * 7_919) % N],
]
for (const [name, at] of sheets) {
  await ok(`${name} of ${N} rows: every row, those up to one, and targets, ascending and each once`, async () => {
    const sid = sheetOf(at)
    same(await sheetRowIds(sid, uid), rowids(sid), 'every row')
    const upTo = 70_000
    same(await sheetRowIds(sid, uid, { upTo }), rowids(sid, ' AND row_index <= ?', upTo), 'the rows up to one')
    // More targets than a page holds, every other row index.
    const targets = Array.from({ length: 60_000 }, (_, k) => k * 2)
    same(await sheetRowIds(sid, uid, { targets }),
      rowids(sid, ' AND row_index IN (SELECT value FROM json_each(?))', JSON.stringify(targets)), 'the targets')
  })
}

done()
