// A restart in the middle of a column's move into the trash, or of its restore (migration 054). The delete or
// the restore runs in another process on the same database, which stops dead in the transaction of a slice
// (its cells written, not committed), as a killed server does. Then this process does what boot does
// (resumeColumnPurges, resumeTrashRestores) and checks: the move goes on from the slice that was lost, and
// every cell ends up in the item once; the restore goes on and lists the column; a restore that had put
// nothing back goes back to the trash as it was, its cells still in the item and nothing under its name. A
// delete that answered "moving" (its move held so it outlasts the wait) and then stopped is finished too.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import purgeMod from '../../server/src/lib/column-purge'
import restoreMod from '../../server/src/services/trash-restore'
import constMod from '../../server/src/lib/constants'
import { columnTrashKit } from './column-trash-kit'
const { resumeColumnPurges } = purgeMod as typeof import('../../server/src/lib/column-purge')
const { resumeTrashRestores } = restoreMod as typeof import('../../server/src/services/trash-restore')
const { HEAVY_SLICE_ROWS, TRASH_SLICE_ROWS } = constMod as typeof import('../../server/src/lib/constants')
const k = columnTrashKit('column-trash-restart')
const { db, uid, ok, done, idle, sheet, order, cells, item, stored, del, restoreOne } = k

// The other process: `what` runs with the statement starting `sql` stopping the process right after its
// `at`-th run, inside that slice's transaction (at 0: never; `pause` ms after each run instead, while `what`
// ends the process itself). Resolves with what it wrote.
const requireHere = createRequire(import.meta.url)
const stopsAt = (sql: string, at: number, what: string, pause = 0) => new Promise<string>((resolve, reject) => {
  const mod = (p: string) => JSON.stringify(requireHere.resolve(p))
  const code = `require(${mod('tsx/cjs/api')}).register();
    console.log = console.warn = () => {};
    const { db } = require(${mod('../../server/src/lib/db')});
    const prepare = db.prepare.bind(db);
    const nap = new Int32Array(new SharedArrayBuffer(4));
    let n = 0;
    db.prepare = (text) => {
      const stmt = prepare(text);
      if (!text.trimStart().startsWith(${JSON.stringify(sql)})) return stmt;
      const run = stmt.run.bind(stmt);
      stmt.run = (...args) => {
        const out = run(...args);
        if (++n === ${at}) process.exit(0);
        Atomics.wait(nap, 0, 0, ${pause});
        return out;
      };
      return stmt;
    };
    const { deleteSheetColumn } = require(${mod('../../server/src/services/column-delete')});
    const { restoreFromTrash } = require(${mod('../../server/src/services/trash-actions')});
    setTimeout(() => process.exit(3), 30000);
    (async () => { ${what}; process.exit(4); })().catch(e => { console.error(e); process.exit(5); });`
  const child = spawn(process.execPath, ['-e', code], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { err += chunk })
  child.on('error', reject)
  child.on('close', c => (c === 0 ? resolve(out) : reject(new Error(`it didn't stop where it should (${c}): ${err}`))))
})

const ROWS = HEAVY_SLICE_ROWS * 2 + 7
const big = () => sheet(['Email', 'Big'], Array.from({ length: ROWS }, (_, i) =>
  (i % 10 === 9 ? { Email: `u${i}@x.co` } : { Email: `u${i}@x.co`, Big: `v${i}` })))
const expected = Array.from({ length: ROWS }, (_, i) => (i % 10 === 9 ? null : `v${i}`))
const valued = expected.filter(v => v !== null).length

await ok('a restart in the middle of the move: the boot resume moves the rest, each cell once', async () => {
  const sid = big()
  const q = (s: string) => JSON.stringify(s)
  await stopsAt('INSERT INTO trash_rows', 2,
    `await deleteSheetColumn(${q(sid)}, ${q(uid)}, 'Big', { bumpDataVersion: true })`)
  const id = db.prepare(`SELECT id FROM trash_items WHERE sheet_id = ? AND kind = 'column'`).pluck().get(sid) as number
  assert.equal(item(id)!.state, 'moving')
  const firstSlice = stored(id).length
  assert.ok(firstSlice > 0 && firstSlice < valued, `one slice was in: ${firstSlice}`)
  assert.equal(item(id)!.row_count, firstSlice, 'the lost slice left no count behind')
  assert.equal(db.prepare('SELECT trash_id FROM column_purges WHERE sheet_id = ?').pluck().get(sid), id)
  assert.deepEqual(order(sid), ['Email'])
  resumeColumnPurges()
  await idle(sid)
  const it = item(id)!
  assert.equal(it.state, 'kept')
  assert.equal(it.row_count, valued)
  const ids = stored(id).map(r => r.row_id)
  assert.equal(new Set(ids).size, valued, 'no cell twice')
  assert.deepEqual(cells(sid, 'Big'), expected.map(() => null))
  assert.equal(db.prepare('SELECT COUNT(*) FROM column_purges WHERE sheet_id = ?').pluck().get(sid), 0)
  const back = (await restoreOne(id)).restored as any
  assert.equal(back.cells_restored, valued)
  assert.deepEqual(cells(sid, 'Big'), expected)
})

await ok('a delete that answered "moving", then a restart: the boot resume moves the rest, each cell once',
  async () => {
    const sid = big()
    const q = (s: string) => JSON.stringify(s)
    // Each slice of the move held 700 ms: 11 slices outlast the delete's wait, and it stops once it answered.
    const said = JSON.parse(await stopsAt('INSERT INTO trash_rows', 0, `const out = await deleteSheetColumn(${q(sid)}, `
      + `${q(uid)}, 'Big', { bumpDataVersion: true }); process.stdout.write(JSON.stringify(out), () => `
      + 'process.exit(0)); await new Promise(() => {})', 700))
    assert.deepEqual(Object.keys(said), ['ok', 'trashId', 'moving'])
    assert.equal(said.moving, true)
    const id = said.trashId as number
    assert.equal(item(id)!.state, 'moving')
    const before = stored(id).length
    assert.ok(before > 0 && before < valued, `part of it was in: ${before}`)
    assert.deepEqual(order(sid), ['Email'])
    resumeColumnPurges()
    await idle(sid)
    assert.deepEqual([item(id)!.state, item(id)!.row_count], ['kept', valued])
    assert.equal(new Set(stored(id).map(r => r.row_id)).size, valued, 'no cell twice')
    assert.deepEqual(cells(sid, 'Big'), expected.map(() => null))
    const back = (await restoreOne(id)).restored as any
    assert.equal(back.cells_restored, valued)
    assert.deepEqual(cells(sid, 'Big'), expected)
  })

await ok('a restart in the middle of the restore: the boot resume puts the rest back, then lists it', async () => {
  const cellsIn = TRASH_SLICE_ROWS * 2 + 3
  const sid = sheet(['Email', 'Small'], Array.from({ length: cellsIn }, (_, i) => ({ Email: `${i}`, Small: `s${i}` })))
  const id = (await del(sid, 'Small'))!
  await stopsAt('DELETE FROM trash_rows WHERE item_id = ? AND seq IN', 2,
    `await restoreFromTrash(${JSON.stringify(uid)}, [${id}], { surface: 'mcp', hasSecretsScope: true })`)
  const it = item(id)!
  assert.equal(it.state, 'restoring')
  assert.equal(it.restore_name, 'Small')
  assert.equal(it.restored, TRASH_SLICE_ROWS, 'one slice was back')
  assert.deepEqual(order(sid), ['Email'], 'not listed until every cell is back')
  resumeTrashRestores()
  await idle(sid)
  assert.equal(item(id), undefined)
  assert.deepEqual(order(sid), ['Email', 'Small'])
  assert.deepEqual(cells(sid, 'Small'), Array.from({ length: cellsIn }, (_, i) => `s${i}`))
})

await ok('a restore stopped before its first cell went back goes back to the trash as it was', async () => {
  const sid = sheet(['Email', 'Small'], Array.from({ length: 300 }, (_, i) => ({ Email: `${i}`, Small: `s${i}` })))
  const id = (await del(sid, 'Small'))!
  const before = stored(id)
  await stopsAt('DELETE FROM trash_rows WHERE item_id = ? AND seq IN', 1,
    `await restoreFromTrash(${JSON.stringify(uid)}, [${id}], { surface: 'mcp', hasSecretsScope: true })`)
  assert.equal(item(id)!.state, 'restoring')
  assert.equal(item(id)!.restored, 0)
  resumeTrashRestores()
  await idle(sid)
  const it = item(id)!
  assert.deepEqual([it.state, it.restore_name, it.restored, it.row_count], ['kept', null, 0, 300])
  assert.deepEqual(stored(id), before)
  assert.deepEqual(order(sid), ['Email'])
  assert.deepEqual(cells(sid, 'Small'), Array.from({ length: 300 }, () => null))
  assert.ok((await restoreOne(id)).restored, 'and it restores afterwards')
  assert.deepEqual(cells(sid, 'Small'), Array.from({ length: 300 }, (_, i) => `s${i}`))
})

done()
