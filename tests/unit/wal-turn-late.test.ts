// Over 200 lines: its cases share the held checkpoint, the log of writes in turn and the timed watch.
// A write in turn past its deadline (lib/wal-turn.ts), on Windows and Linux (writesWaitForCheckpoints,
// lib/wal-checkpointer.ts): there a commit that writes the WAL while the checkpoint worker's checkpoint runs waits
// inside it, on the event loop (on the Windows CI runner COMMIT took up to 149 ms during a checkpoint and 19 ms
// otherwise; on the Linux one a clear's slice up to 128 ms). So a write that must be made (`anyway`) begins only once a
// running checkpoint has answered, past `until` too: it waits, the loop free, at most the wait's limit for that
// checkpoint (logged once, never waited for again). The switch is on here on every platform but where a case says
// otherwise, so macOS runs that path too. Each write in turn is named by what it writes. A transform_column call that
// starts while a checkpoint runs past its whole time makes three past its deadline: the column add (on the runner, the
// one-frame transaction that held transform-regex-pages' loop 783 and 634 ms), data_version and the pass record. One
// that runs out of time waiting at its pause makes two: data_version and its stop (the pass record already written).
// None begins while the checkpoint runs, and the call answers once it has answered. Switched off (macOS's own), a write
// past its deadline writes at once.
// Where a server makes the -wal file its full size at start (Windows), so does this, after the migrations: no timed
// write grows it (on the Windows runner a commit that did could wait on the OS, off the CPU).
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import walMod from '../../server/src/lib/wal-checkpointer'
import turnMod from '../../server/src/lib/wal-turn'
import transformMod from '../../server/src/services/column-transform'
import { heldText, loopWatch } from './loop-watch'
import { sizeWalLikeAServer, walGrowth } from './sqlite-write-probe'
import { passed } from './ends-on-its-own'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const w = walMod as typeof import('../../server/src/lib/wal-checkpointer')
const { inWalTurn, setBeforeTurnWriteForTests, takeWalTurnStats } =
  turnMod as typeof import('../../server/src/lib/wal-turn')
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
const walSized = sizeWalLikeAServer(db, process.env.DB_PATH!)
const logged: string[] = []
console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')) }
let failures = 0
async function ok(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
w.setWritesWaitForCheckpointsForTests(true)

db.exec('CREATE TABLE late_rows (id INTEGER PRIMARY KEY, b BLOB)')
db.transaction(() => {
  const add = db.prepare('INSERT INTO late_rows (b) VALUES (randomblob(3000))')
  for (let i = 0; i < 1000; i++) add.run()
}).immediate()
const rewrite = db.prepare('UPDATE late_rows SET b = randomblob(3000) WHERE id BETWEEN ? AND ?')

// Each write in turn: past its deadline or not, whether a checkpoint asked of the worker was still running when it
// began, and what it wrote, named by its statements.
interface TurnWrite { late: boolean; during: boolean; what: string[] }
let writes: TurnWrite[] = []
setBeforeTurnWriteForTests(late => { writes.push({ late, during: w.checkpointAsked(), what: [] }) })
const NAMES: Array<[string, string]> = [['UPDATE sheets SET column_order', 'column add'],
  ['UPDATE sheets SET data_version', 'data_version'], ['UPDATE rows SET data', 'page'],
  ['INSERT INTO transform_passes', 'pass record'], ['UPDATE late_rows', 'rewrite']]
const prepare = db.prepare.bind(db)
db.prepare = ((sql: string) => {
  const stmt = prepare(sql)
  const name = NAMES.find(([head]) => sql.trimStart().startsWith(head))?.[1]
  if (!name) return stmt
  const run = stmt.run.bind(stmt)
  return Object.assign(stmt, { run: (...a: unknown[]) => {
    const now = writes[writes.length - 1]
    if (now && !now.what.includes(name)) now.what.push(name)
    return run(...a)
  } })
}) as typeof db.prepare
const lateOnes = () => writes.filter(x => x.late).map(x => `${x.what.join(' + ') || 'nothing'}`
  + `${x.during ? ' (began while the checkpoint ran)' : ''}`)

// A checkpoint asked of the worker with frames to copy, held `holdMs` first, as on a slow disk.
async function heldCheckpoint(holdMs: number): Promise<{ asked: Promise<unknown> }> {
  await w.walCheckpointerIdle()
  await w.checkpointInBackground()
  rewrite.run(1, 50)
  w.setCheckpointDelayForTests(holdMs)
  const asked = w.checkpointInBackground()
  w.setCheckpointDelayForTests(0)
  return { asked }
}
// `fn` timed, with the event loop watched and 5 ms timers counted meanwhile; none of its writes grew the -wal file.
async function timed<T>(fn: () => Promise<T>) {
  const watch = loopWatch(() => [])
  await watch.ready
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 5)
  const grown = walGrowth(process.env.DB_PATH!, walSized)
  const t0 = performance.now()
  try {
    const out = await fn()
    const r = { out, ms: performance.now() - t0, ticks, watched: watch() }
    assert.equal(grown([]), '', 'writes that grew the -wal file')
    return r
  } finally { clearInterval(timer) }
}
// A write already past its deadline that must be made: when it began after the call.
async function lateWrite() {
  writes = []
  const t0 = performance.now()
  let began = -1
  const r = await timed(() => inWalTurn(() => { began = performance.now() - t0; rewrite.run(51, 60) }, Date.now() - 1,
    true))
  return { ...r, began, during: writes[0]?.during }
}

await ok('a write past its deadline that must be made waits for the running checkpoint\'s answer, the event loop '
  + 'free, then writes', async () => {
  const { asked } = await heldCheckpoint(800)
  takeWalTurnStats()
  const s = await lateWrite()
  console.log(`      began after ${s.began.toFixed(0)} ms; ${s.ticks} timers ran; ${heldText(s.watched)}`)
  assert.equal(s.during, false, 'it began while the checkpoint ran')
  assert.ok(s.began >= 700, `it began ${s.began.toFixed(0)} ms in, while the checkpoint ran`)
  assert.ok(s.ticks >= 20 && s.watched.cpuMs < 50,
    `${s.ticks} timers ran, the loop held ${s.watched.cpuMs.toFixed(0)} ms on the CPU`)
  assert.equal(takeWalTurnStats().checkpointWaits, 1, 'waits for a running checkpoint')
  await asked
})

await ok('past its deadline the wait has its limit: a checkpoint that never answers holds the write no longer than '
  + 'that, once (logged), and the next write past its deadline doesn\'t wait for it', async () => {
  w.setCheckpointWaitLimitForTests(300)
  const before = logged.length
  try {
    const { asked } = await heldCheckpoint(3_000)
    const first = await lateWrite()
    const second = await lateWrite()
    console.log(`      the first began after ${first.began.toFixed(0)} ms, the second after `
      + `${second.began.toFixed(0)} ms`)
    assert.ok(first.began >= 250 && first.began < 2_000, `the first began after ${first.began.toFixed(0)} ms`)
    assert.ok(second.began < 250, `the second waited ${second.began.toFixed(0)} ms for the same checkpoint`)
    assert.equal(logged.slice(before).filter(l => l.includes('gave no answer in 300 ms')).length, 1,
      logged.slice(before).join('\n'))
    await asked
  } finally { w.setCheckpointWaitLimitForTests(null) }
})

// A sheet of `rows` rows whose column N holds `cell(i)`, and its owner.
function seeded(rows: number, cell: (i: number) => string) {
  const sid = uuid(), uid = uuid(), tid = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
  db.prepare(`INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,'S',0,'["N"]')`)
    .run(sid, tid, uid)
  const add = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => { for (let i = 0; i < rows; i++) add.run(uuid(), sid, uid, i, JSON.stringify({ N: cell(i) })) })
    .immediate()
  return { sid, uid }
}
const template = (sheetId: string) => ({ sheetId, operation: 'template' as const, template: '{{N}}!',
  targetColumn: 'M' })

await ok('a transform call that starts while a checkpoint runs past its whole time: the column add, data_version '
  + 'and the pass record come past its deadline, none begins while the checkpoint runs, and the call answers '
  + 'once it has answered', async () => {
  const { sid, uid } = seeded(300, i => `r${i}`)
  const { asked } = await heldCheckpoint(3_000)
  writes = []
  const s = await timed(() => transformColumn(uid, template(sid)))
  console.log(`      answered after ${s.ms.toFixed(0)} ms; past its deadline: ${lateOnes().join(', ')}; `
    + `${heldText(s.watched)}`)
  assert.ok('ok' in s.out && s.out.ok.updated === 0 && s.out.ok.next_cursor, JSON.stringify(s.out))
  assert.deepEqual(lateOnes(), ['column add', 'data_version', 'pass record'])
  assert.ok(s.ms >= 2_800, `answered after ${s.ms.toFixed(0)} ms, before the checkpoint did`)
  assert.ok(s.watched.cpuMs < 100, `the loop held ${s.watched.cpuMs.toFixed(0)} ms on the CPU`)
  await asked
})

await ok('a transform call that runs out of time waiting at its pause: data_version and its stop come past its '
  + 'deadline, and neither begins while the checkpoint runs', async () => {
  // Cells of about 1,000 characters: the walk's pages take the WAL to its pause within the call's time.
  const { sid, uid } = seeded(8_000, i => `n${i}-${'x'.repeat(1_000)}`)
  // The sheet's own frames copied back first, so only the call's pages fill the WAL.
  await w.walCheckpointerIdle()
  await w.checkpointInBackground()
  writes = []
  w.setCheckpointDelayForTests(3_000)
  try {
    const s = await timed(() => transformColumn(uid, template(sid)))
    console.log(`      answered after ${s.ms.toFixed(0)} ms, ${writes.length} writes; past its deadline: `
      + `${lateOnes().join(', ')}; ${heldText(s.watched)}`)
    assert.ok('ok' in s.out && s.out.ok.updated > 0 && s.out.ok.next_cursor, JSON.stringify(s.out))
    assert.deepEqual(lateOnes(), ['data_version', 'nothing'])
    assert.ok(s.watched.cpuMs < 100, `the loop held ${s.watched.cpuMs.toFixed(0)} ms on the CPU`)
  } finally {
    w.setCheckpointDelayForTests(0)
    await w.walCheckpointerIdle()
  }
})

await ok('switched off (macOS\'s own), a write past its deadline writes at once, while the checkpoint runs',
  async () => {
    w.setWritesWaitForCheckpointsForTests(false)
    const { asked } = await heldCheckpoint(800)
    const s = await lateWrite()
    console.log(`      began after ${s.began.toFixed(0)} ms`)
    assert.ok(s.began < 200 && s.during === true, `it began after ${s.began.toFixed(0)} ms, during: ${s.during}`)
    await asked
  })

setBeforeTurnWriteForTests(null)
await w.closeWalCheckpointer()
if (failures > 0) { console.log(`${failures} wal-turn-late assertion(s) failed`); process.exit(1) }
console.log('All wal-turn-late assertions passed.')
passed()
