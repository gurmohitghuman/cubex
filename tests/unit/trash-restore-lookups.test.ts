// Lookups whose fill failed while the sheet they read was in the trash fill
// again once it is restored (lib/trash/lookups.ts lookupsFillAgain), for good:
// the restore sets them filling in its transaction, so a restart before they
// got their sheet resumes them. One that finds its sheet busy tries again
// later; if, between the two tries, its own sheet went to the trash it is
// parked until that is restored, if a run started filling a column it reads in
// the other sheet it waits for the run, and if its column was deleted it isn't
// brought back. One whose source column is gone fails with that (its values
// kept). Only those the trash failed, unbroken, are touched: those that look in
// the restored sheet, and those on it whose other sheet is live.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { v4 as uuid } from 'uuid'
import { refillKit, IN_TRASH } from './trash-refill-kit'
import restoreMod from '../../server/src/services/trash-restore-sheet'
import fillMod from '../../server/src/services/derived-fill'
import kindMod from '../../server/src/services/lookup-kind'
import recMod from '../../server/src/lib/lookup-columns'
import busyMod from '../../server/src/lib/sheet-busy'
import deleteMod from '../../server/src/services/column-delete'
import helpersMod from '../../server/src/lib/sql-helpers'
const { restoreSheetItem } = restoreMod as typeof import('../../server/src/services/trash-restore-sheet')
const { derivedFillWait, resumeDerivedFills } = fillMod as typeof import('../../server/src/services/derived-fill')
const { lookupKind } = kindMod as typeof import('../../server/src/services/lookup-kind')
const { lookupColumnFor } = recMod as typeof import('../../server/src/lib/lookup-columns')
const { withSheetBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { deleteSheetColumn } = deleteMod as typeof import('../../server/src/services/column-delete')
const { getSheetColumns } = helpersMod as typeof import('../../server/src/lib/sql-helpers')
const k = refillKit('trash-restore-lookups')
const { db, uid, ok, done, idle, rowsOf, place, trash, cells, statusOf, until, lookup, failedOnTrash } = k
console.error = () => {}

const restore = (id: number) => { const r = restoreSheetItem(uid, id); assert.ok('ok' in r, JSON.stringify(r)) }
// The sheet busy (the first lookup's fill, a sort) until release().
const hold = (sid: string) => {
  let release!: () => void
  const held = withSheetBusy(sid, 'holding', () => new Promise<void>(r => { release = r }))
  return async () => { release(); await held }
}
// What a restore starts after its request (startRestored, one setImmediate) makes its first try for each
// sheet: a hold refuses it, so that lookup tries again HEAVY_JOB_RETRY_MS later (whenSheetFree).
const firstTry = () => new Promise(r => setImmediate(r))
// The restore in another process that stops right after it: what it started in memory is lost.
const requireHere = createRequire(import.meta.url)
const restoreThenStop = (item: number) => new Promise<void>((resolve, reject) => {
  const code = `require(${JSON.stringify(requireHere.resolve('tsx/cjs/api'))}).register();
    const { restoreSheetItem } = require(${JSON.stringify(
      requireHere.resolve('../../server/src/services/trash-restore-sheet'))});
    const r = restoreSheetItem(${JSON.stringify(uid)}, ${item});
    process.exit('ok' in r ? 0 : 3);`
  const child = spawn(process.execPath, ['-e', code], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr.on('data', chunk => { err += chunk })
  child.on('error', reject)
  child.on('close', c => (c === 0 ? resolve() : reject(new Error(`the restore exited ${c}: ${err}`))))
})

await ok('a restart before the lookups the restore set to fill again got their sheet still fills them', async () => {
  const a = place().sid
  const other = place()
  await lookup(a, other.sid, 'Found', 'exists')
  await lookup(a, other.sid, 'Count', 'count')
  const item = await failedOnTrash(a, other)
  await restoreThenStop(item)
  assert.equal(db.prepare('SELECT trash_id FROM sheets WHERE id = ?').pluck().get(other.sid), null)
  resumeDerivedFills(lookupKind) // as at boot
  await until('both are done', () => statusOf(a, 'Found') === 'done' && statusOf(a, 'Count') === 'done')
  assert.deepEqual(cells(a, 'Found'), ['Yes', 'Yes', 'Yes'])
  assert.ok(cells(a, 'Count').every(c => c !== undefined && c !== ''), JSON.stringify(cells(a, 'Count')))
})

await ok('a run started on a column it reads in the other sheet, between two tries of the lookup for its busy '
  + 'sheet, makes it wait at the second, then it fills', async () => {
  const a = place().sid
  const other = place()
  const id = await lookup(a, other.sid, 'Who', 'value', 'Name')
  const item = await failedOnTrash(a, other)
  const free = hold(a)
  restore(item)
  await firstTry()
  // A run starts on the restored sheet, writing the column the lookup returns.
  const run = uuid()
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status)
    VALUES (?,?,?,'Name','p','running')`).run(run, other.sid, uid)
  await free()
  await until('the fill waits for the run', () => /Waiting for a run to finish filling "Name"/
    .test(derivedFillWait(id) ?? ''))
  assert.equal(statusOf(a, 'Who'), 'filling')
  db.prepare("UPDATE ai_runs SET status = 'completed' WHERE id = ?").run(run)
  await until('it is done', () => statusOf(a, 'Who') === 'done')
  assert.deepEqual(cells(a, 'Who'), ['N0', 'N1', 'N2'])
})

await ok('a lookup whose own sheet goes to the trash between two tries for it is parked at the second, then fills '
  + 'once that is restored', async () => {
  const p = place()
  const other = place()
  const id = await lookup(p.sid, other.sid, 'Found', 'exists')
  const item = await failedOnTrash(p.sid, other)
  const free = hold(p.sid)
  restore(item)
  await firstTry()
  await free()
  const own = trash('sheet', p)
  await until('the fill is parked', () => derivedFillWait(id) === IN_TRASH, 6_000)
  assert.equal(statusOf(p.sid, 'Found'), 'filling')
  restore(own)
  await until('it is done', () => statusOf(p.sid, 'Found') === 'done')
  assert.deepEqual(cells(p.sid, 'Found'), ['Yes', 'Yes', 'Yes'])
})

await ok('a lookup whose source column was deleted meanwhile fails with that and keeps its values', async () => {
  const a = place().sid
  const other = place()
  await lookup(a, other.sid, 'Found', 'exists')
  const item = await failedOnTrash(a, other, false)
  const gone = await deleteSheetColumn(a, uid, 'Email')
  assert.deepEqual(gone, { ok: true })
  await idle(a)
  restore(item)
  assert.equal(statusOf(a, 'Found'), 'filling')
  await until('the fill ends', () => statusOf(a, 'Found') !== 'filling')
  await idle(a)
  assert.equal(statusOf(a, 'Found'), 'failed')
  assert.match(lookupColumnFor(a, uid, 'Found')?.error_message ?? '', /"Email", the column it looks up/)
  assert.deepEqual(cells(a, 'Found'), ['Yes', 'Yes', 'Yes'])
})

await ok("a lookup column deleted between two tries of its fill for its busy sheet isn't brought back", async () => {
  const a = place().sid
  const other = place()
  await lookup(a, other.sid, 'Found', 'exists')
  await lookup(a, other.sid, 'Count', 'count')
  const item = await failedOnTrash(a, other)
  const free = hold(a)
  restore(item)
  await firstTry()
  await free()
  // Before the lookups try again, the person deletes Count (its record goes with it).
  const gone = await deleteSheetColumn(a, uid, 'Count')
  assert.deepEqual(gone, { ok: true })
  await until('Found is done', () => statusOf(a, 'Found') === 'done')
  await new Promise(r => setTimeout(r, 2_500)) // past the next try for the sheet
  await idle(a)
  assert.ok(!getSheetColumns(a, uid, false).includes('Count'), JSON.stringify(getSheetColumns(a, uid, false)))
  assert.equal(lookupColumnFor(a, uid, 'Count'), undefined)
  assert.ok(rowsOf(a).every(r => !('Count' in JSON.parse(r.data))), 'no row holds a Count cell')
})

// Set straight in the records: what lookupsFillAgain must match, or leave alone.
const failedWith = (sid: string, column: string, message: string, broken: string | null = null) =>
  db.prepare(`UPDATE lookup_columns SET fill_status = 'failed', error_message = ?, broken = ?
    WHERE sheet_id = ? AND column_name = ?`).run(message, broken, sid, column)

await ok('restoring a sheet fills again its lookup the trash failed whose other sheet is live; one failed '
  + 'otherwise, or broken since, stays failed', async () => {
  const p = place()
  const other = place()
  await lookup(p.sid, other.sid, 'Found', 'exists')
  await lookup(p.sid, other.sid, 'Count', 'count')
  await lookup(p.sid, other.sid, 'Again', 'exists')
  const own = trash('sheet', p)
  const name = db.prepare('SELECT name FROM sheets WHERE id = ?').pluck().get(other.sid) as string
  const inTrash = `The sheet "${name}" it looks in is in the trash.`
  // The words in the middle of another failure, and the trash's words on a lookup broken since.
  failedWith(p.sid, 'Found', `${inTrash} It failed again after that.`)
  failedWith(p.sid, 'Count', inTrash, `The column "Email" in "${name}" was deleted.`)
  // The trash's words exactly, unbroken, the sheet it looks in live (what an older build left after restoring
  // that sheet): only the restored sheet being its own matches it. Its cells emptied, so the fill shows.
  failedWith(p.sid, 'Again', inTrash)
  db.prepare('UPDATE rows SET data = json_remove(data, ?) WHERE sheet_id = ?').run('$."Again"', p.sid)
  restore(own)
  assert.deepEqual(['Found', 'Count', 'Again'].map(c => statusOf(p.sid, c)), ['failed', 'failed', 'filling'])
  await until('Again is done', () => statusOf(p.sid, 'Again') === 'done')
  await idle(p.sid)
  assert.deepEqual(cells(p.sid, 'Again'), ['Yes', 'Yes', 'Yes'])
  assert.deepEqual([statusOf(p.sid, 'Found'), statusOf(p.sid, 'Count')], ['failed', 'failed'])
})

done()
