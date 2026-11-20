// Temporary (removed before the review): on this runner, how long a small commit on the API thread takes while the
// checkpoint worker copies a big WAL back (lib/wal-checkpointer.ts: on Windows such a commit can wait inside it),
// against the same commits with no checkpoint running. Run with tsx and a throwaway DB_PATH.
import { performance } from 'node:perf_hooks'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import slicesMod from '../../server/src/lib/slices'
import walMod from '../../server/src/lib/wal-checkpointer'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { withoutAutoCheckpoint } = slicesMod as typeof import('../../server/src/lib/slices')
const { checkpointInBackground, closeWalCheckpointer } = walMod as typeof import('../../server/src/lib/wal-checkpointer')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
  .run(sid, tid, uid, 'S', 0, JSON.stringify(['A']))
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
const touch = db.prepare('UPDATE rows SET data = json_set(data, \'$.B\', ?) WHERE sheet_id = ? AND row_index = ?')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]
const line = (a: number[]) => a.length ? `${a.length} commits, median ${pct(a, 0.5).toFixed(1)} ms, `
  + `p99 ${pct(a, 0.99).toFixed(1)} ms, max ${Math.max(...a).toFixed(1)} ms` : 'no commit'

let index = 0
// Rows of 1 KB written in slices of 1,000, SQLite's own checkpoint off: the WAL grows by about that much.
function grow(rows: number) {
  const data = JSON.stringify({ A: 'a'.repeat(1000) })
  for (let done = 0; done < rows; done += 1000) {
    withoutAutoCheckpoint(() => db.transaction(() => {
      for (let i = 0; i < 1000; i++) insert.run(uuid(), sid, uid, index++, data)
    }).immediate())
  }
}
// One small commit every 5 ms while `going()`, each timed; at most `max` of them.
async function commits(going: () => boolean, max = 400) {
  const ms: number[] = []
  while (going() && ms.length < max) {
    const t = performance.now()
    withoutAutoCheckpoint(() => db.transaction(() => { touch.run(String(t), sid, ms.length % 1000) }).immediate())
    ms.push(performance.now() - t)
    await sleep(5)
  }
  return ms
}

for (const round of [1, 2, 3]) {
  grow(40_000)
  const t0 = performance.now()
  let done = false
  const asked = checkpointInBackground().finally(() => { done = true })
  const during = await commits(() => !done)
  await asked
  const checkpointMs = performance.now() - t0
  const quiet = await commits(() => true, 100)
  console.log(`round ${round} (${process.platform}): the checkpoint took ${checkpointMs.toFixed(0)} ms; during it `
    + `${line(during)}; with none running ${line(quiet)}`)
}
await closeWalCheckpointer()
process.exit(0)
