// A transform_column call waiting for the WAL to be copied back (services/column-transform-pages.ts,
// lib/wal-checkpointer.ts) never waits past what can help. With a read held open on a second connection (an
// outside tool: the checkpoint can copy none of the frames it might read), the call that fills the WAL to its
// bound answers at once with a cursor, well under its 2 s budget, and each next call writes one page and answers
// at once too. With a checkpoint already running that takes 5 s on the worker, the call answers within its budget
// and one page, not when the checkpoint ends; the next call, made at once, waits for that checkpoint all its time
// and says so, writing no rows and answering the same cursor; the one after waits for it before its first page,
// so no page is written past the WAL's bound. Going on with the cursors ends every row exactly once.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import apiMod from '../../server/src/lib/api-v1-constants'
import walMod from '../../server/src/lib/wal-checkpointer'
import constMod from '../../server/src/lib/constants'
import { sqliteWriteProbe } from './sqlite-write-probe'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { transformColumn, TRANSFORM_WAITED_NOTE } =
  transformMod as typeof import('../../server/src/services/column-transform')
const { TRANSFORM_MAX_CALL_MS, TRANSFORM_PAGE_ROWS } = apiMod as typeof import('../../server/src/lib/api-v1-constants')
const { WAL_PAUSE_FRAMES } = constMod as typeof import('../../server/src/lib/constants')
const { closeWalCheckpointer, setCheckpointDelayForTests, takeWalCheckpointerStats, walCheckpointerIdle } =
  walMod as typeof import('../../server/src/lib/wal-checkpointer')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const ROWS = 30_000
// Wide rows: the WAL reaches its bound well before a call's 10,000-row cap.
const NOTES = 'n'.repeat(500)
const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
  .run(sid, tid, uid, 'Big', 0, JSON.stringify(['N', 'Notes']))
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
db.transaction(() => {
  for (let i = 0; i < ROWS; i++) insert.run(uuid(), sid, uid, i, JSON.stringify({ N: `r${i}`, Notes: NOTES }))
}).immediate()
const probe = sqliteWriteProbe(db, process.env.DB_PATH!)
// Reads its own target: a row written twice would end with its suffix twice.
const call = (suffix: string, cursor?: string) => transformColumn(uid, { sheetId: sid, operation: 'template',
  template: `{{N}}${suffix}`, targetColumn: 'N', ...(cursor === undefined ? {} : { cursor }) })
const once = (suffix: string) => db.prepare(`SELECT count(*) FROM rows WHERE sheet_id = ?
  AND json_extract(data, '$.N') = 'r' || row_index || ?`).pluck().get(sid, suffix) as number
async function timed(suffix: string, cursor?: string) {
  const t0 = performance.now()
  const out = await call(suffix, cursor)
  const ms = Math.round(performance.now() - t0)
  assert.ok('ok' in out && out.ok.next_cursor, JSON.stringify(out))
  return { ms, updated: out.ok.updated, cursor: out.ok.next_cursor }
}
async function finish(suffix: string, cursor: string) {
  for (let next: string | undefined = cursor; next;) {
    const out = await call(suffix, next)
    assert.ok('ok' in out, JSON.stringify(out))
    next = out.ok.next_cursor
  }
}

async function main() {
  await check('a read held open on another connection: the call answers at once with a cursor, and so does each '
    + 'next one after a page; going on ends every row once', async () => {
    probe.reset()
    const reader = new Database(process.env.DB_PATH!)
    let cursor: string
    try {
      reader.exec('BEGIN')
      reader.prepare('SELECT count(*) FROM rows').get()
      const first = await timed('a')
      const next = await timed('a', first.cursor)
      console.log('     ', JSON.stringify({ first: [first.ms, first.updated], next: [next.ms, next.updated] }))
      assert.ok(first.ms < TRANSFORM_MAX_CALL_MS * 0.75 && first.updated < ROWS, JSON.stringify(first))
      assert.ok(next.ms < TRANSFORM_MAX_CALL_MS / 4, JSON.stringify(next))
      assert.equal(next.updated, TRANSFORM_PAGE_ROWS)
      cursor = next.cursor
    } finally { reader.exec('COMMIT'); reader.close() }
    await finish('a', cursor)
    assert.equal(once('a'), ROWS)
  })

  await check('a checkpoint already running for 5 s: the call answers within its budget and one page; the next '
    + 'call waits for it all its time and says so, writing nothing; the one after waits for it before its first '
    + 'page', async () => {
    probe.reset()
    takeWalCheckpointerStats()
    setCheckpointDelayForTests(5000)
    let first: Awaited<ReturnType<typeof timed>>
    try { first = await timed('b') } finally { setCheckpointDelayForTests(0) }
    const page = Math.ceil(probe.read().longestTransactionMs)
    const waits = takeWalCheckpointerStats().pauses
    console.log('     ', JSON.stringify({ ms: first.ms, updated: first.updated, longestPageMs: page, waits }))
    assert.equal(waits, 1, 'it waited for the checkpoint (not stopped by its row cap)')
    assert.ok(first.ms <= TRANSFORM_MAX_CALL_MS + page + 150, `answered after ${first.ms} ms`)
    // At once: that checkpoint has about 3 s left, the call 2 s.
    assert.deepEqual(await call('b', first.cursor),
      { ok: { updated: 0, created_column: null, next_cursor: first.cursor, note: TRANSFORM_WAITED_NOTE } })
    // At once again, while that checkpoint still runs with the WAL past its bound.
    const next = await timed('b', first.cursor)
    const w = probe.read()
    console.log('     ', JSON.stringify({ next: [next.ms, next.updated], before: w.mostWalFramesBeforeWrite }))
    assert.ok(w.mostWalFramesBeforeWrite < WAL_PAUSE_FRAMES, `a page was written with ${w.mostWalFramesBeforeWrite} `
      + 'frames waiting in the WAL')
    await walCheckpointerIdle()
    await finish('b', next.cursor)
    assert.equal(once('ab'), ROWS)
  })
  await closeWalCheckpointer()
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-wal-wait assertions passed.')
    process.exit(0)
  })
