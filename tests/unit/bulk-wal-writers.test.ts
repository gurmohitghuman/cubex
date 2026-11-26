// Several background bulk writers at once (lib/bulk-slices.ts): each finds room in the WAL, then waits for its slice
// turn behind the others, and their slices used to go in one after another past the pause (five writers: the pause
// and five slices). Now each reads the WAL again in its turn and waits for the worker first when it's past the
// pause, so the WAL stays within its room (WAL_BULK_ROOM_SHARE of journal_size_limit) and every row is written.
// Rows of about 1.5 KB with random ids, so a slice of 1,000 rewrites about 1,000 pages; every checkpoint on the
// worker held 300 ms (bulk-wal-kit.ts). A read of the WAL that throws in the turn gives the turn back.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import constMod from '../../server/src/lib/constants'
import walMod from '../../server/src/lib/wal-checkpointer'
import bulkMod from '../../server/src/lib/bulk-slices'
import turnMod from '../../server/src/lib/slice-turn'
import { bulkWalKit } from './bulk-wal-kit'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { WAL_BULK_PAUSE_FRAMES, WAL_BULK_ROOM_SHARE } = constMod as typeof import('../../server/src/lib/constants')
const { closeWalCheckpointer } = walMod as typeof import('../../server/src/lib/wal-checkpointer')
const { autoCheckpointHolders, runInCheckpointedSlices } = bulkMod as typeof import('../../server/src/lib/bulk-slices')
const { takeSliceTurn } = turnMod as typeof import('../../server/src/lib/slice-turn')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
let failures = 0
async function ok(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const { measure } = bulkWalKit()
const page = db.pragma('page_size', { simple: true }) as number
const sizeLimit = db.pragma('journal_size_limit', { simple: true }) as number
const room = Math.floor((WAL_BULK_ROOM_SHARE * sizeLimit) / (page + 24))

const WRITERS = 5, ROWS_EACH = 8_000, SLICE = 1_000
const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'Wide', JSON.stringify(['N']))
const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
db.transaction(() => {
  for (let i = 0; i < WRITERS * ROWS_EACH; i++) {
    ins.run(uuid(), sid, uid, i, JSON.stringify({ N: '', P: 'p'.repeat(1_500) }))
  }
}).immediate()
// In id order (random), each writer its own share.
const rowids = db.prepare('SELECT rowid FROM rows WHERE sheet_id = ? ORDER BY id').pluck().all(sid) as number[]
const set = db.prepare(`UPDATE rows SET data = json_set(data, '$.N', ?)
  WHERE rowid IN (SELECT value FROM json_each(?))`)
const rewrite = (w: number) => {
  const mine = rowids.slice(w * ROWS_EACH, (w + 1) * ROWS_EACH)
  let i = 0
  return () => {
    set.run(`w${w}`, JSON.stringify(mine.slice(i, i + SLICE)))
    i += SLICE
    return i < mine.length
  }
}
const count = (w: number) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
  AND json_extract(data, '$.N') = ?`).pluck().get(sid, `w${w}`) as number

await ok(`${WRITERS} writers at once: the WAL within its room, every row written`, async () => {
  const r = await measure(`${WRITERS} writers`, () =>
    Promise.all(Array.from({ length: WRITERS }, (_, w) => runInCheckpointedSlices(rewrite(w)))), { pause: true })
  for (let w = 0; w < WRITERS; w++) assert.equal(count(w), ROWS_EACH, `writer ${w}`)
  const slice = r.w.mostTransactionFrames
  // The way it was: the pause (room less one slice) and a slice from each writer past it.
  assert.ok(room - slice + (WRITERS - 1) * slice > room + slice, `slices of ${slice} frames show nothing`)
  assert.ok(r.w.mostWalFrames <= room, `the WAL peaked at ${r.w.mostWalFrames} frames, room for ${room}`)
  assert.ok(r.w.mostWalFrames >= WAL_BULK_PAUSE_FRAMES, `${r.w.mostWalFrames} frames never reached the pause`)
})

// Reading the WAL in its turn throws (the connection busy, say): the slice fails, and the next writer still gets
// a turn. Held, every bulk writer on the server would wait for it until a restart.
await ok('a read of the WAL that throws in the slice turn gives the turn back', async () => {
  const pragma = db.pragma
  db.pragma = ((...a: Parameters<typeof pragma>) => {
    if (/pastPause/.test(new Error().stack!)) throw new Error('the WAL unread')
    return pragma.apply(db, a)
  }) as typeof pragma
  try {
    await assert.rejects(runInCheckpointedSlices(() => false), /the WAL unread/)
  } finally {
    db.pragma = pragma
  }
  assert.equal(autoCheckpointHolders(), 0)
  const next = await Promise.race([takeSliceTurn(), new Promise<null>(r => setTimeout(() => r(null), 2_000))])
  assert.ok(next, 'the slice turn was never given back')
  next()
})

await closeWalCheckpointer()
if (failures > 0) { console.error(`${failures} bulk-wal-writers assertion(s) failed`); process.exit(1) }
console.log('All bulk-wal-writers assertions passed.')
process.exit(0)
