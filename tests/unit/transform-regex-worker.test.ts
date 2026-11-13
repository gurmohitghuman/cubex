// transform_column's regex_extract runs on a worker thread, a page's cells at a time, before the page's write
// transaction (lib/transform-regex-host.ts). Patterns the guard passes, because no group repeats a quantifier,
// still backtrack for hours on a long cell; each shape is first timed on its own worker with a hard 2 s deadline
// (never on the API thread), and the times are printed. Through transform_column, a page the worker hasn't
// answered within TRANSFORM_REGEX_PAGE_MS ends the call with words that say why: on its first page no cell is
// written, on a later one the rows before stay written. Meanwhile the event loop keeps answering, and a pattern
// that works extracts the same values the API thread would. A row changed between the worker's read and the page's
// transaction makes the page write nothing and read again; changed every time, the call fails after 3 tries.
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import transformMod from '../../server/src/services/column-transform'
import opsMod from '../../server/src/lib/transform-ops'
import hostMod from '../../server/src/lib/transform-regex-host'
import constMod from '../../server/src/lib/api-v1-constants'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { transformColumn } = transformMod as typeof import('../../server/src/services/column-transform')
const { applyCellOp, validateRegexPattern } = opsMod as typeof import('../../server/src/lib/transform-ops')
const { regexPages, SlowPattern, SLOW_PATTERN_FIX, SLOW_PATTERN_WHY } =
  hostMod as typeof import('../../server/src/lib/transform-regex-host')
const { TRANSFORM_PAGE_ROWS, TRANSFORM_REGEX_PAGE_MS } =
  constMod as typeof import('../../server/src/lib/api-v1-constants')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

// Run after each read of a page made outside a transaction (the one whose cells go to the worker).
let afterWorkerRead: (() => void) | null = null
const prepare = db.prepare.bind(db)
db.prepare = ((sql: string) => {
  const stmt = prepare(sql)
  if (!sql.startsWith('SELECT rowid AS rid, data FROM rows')) return stmt
  const all = stmt.all.bind(stmt)
  Object.assign(stmt, { all: (...a: unknown[]) => {
    const rows = all(...a)
    if (!db.inTransaction) afterWorkerRead?.()
    return rows
  } })
  return stmt
}) as typeof db.prepare

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const A28 = 'a'.repeat(28)
const LONG_A = 'a'.repeat(10_000)
const TWELVE_STARS = `${'a*'.repeat(12)}b`
// [pattern, cell, stalls]: every one passes the guard.
const SHAPES: Array<[string, string, boolean]> = [
  ['(a?){28}a{28}', A28, false],
  [`${'a?'.repeat(28)}${'a'.repeat(28)}`, A28, false],
  [TWELVE_STARS, LONG_A, true],
  ['\\d+\\d+b', '1'.repeat(10_000), true],
  ['\\d{0,200}\\d{0,200}b', '1'.repeat(10_000), true],
]

// One match on its own worker, stopped at 2 s: its time, or null.
function timed(pattern: string, cell: string): Promise<number | null> {
  return new Promise(resolve => {
    const w = new Worker(`const { parentPort, workerData: d } = require('node:worker_threads');
      const t = performance.now(); new RegExp(d.pattern).exec(d.cell); parentPort.postMessage(performance.now() - t)`,
    { eval: true, workerData: { pattern, cell } })
    const stop = setTimeout(() => { void w.terminate(); resolve(null) }, 2000)
    w.once('message', (ms: number) => { clearTimeout(stop); void w.terminate(); resolve(ms) })
  })
}

// The event loop's longest gap while `fn` runs, from a 10 ms timer.
async function longestGap<T>(fn: () => Promise<T>): Promise<{ out: T; gap: number }> {
  let last = performance.now(), gap = 0
  const tick = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now }, 10)
  try { return { out: await fn(), gap } } finally { clearInterval(tick) }
}

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
let made = 0
function sheet(cells: string[]): string {
  const id = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
    .run(id, tid, uid, `S${made}`, made++, JSON.stringify(['S']))
  const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => cells.forEach((S, i) => insert.run(uuid(), id, uid, i, JSON.stringify({ S })))).immediate()
  return id
}
const targets = (id: string) => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index')
  .pluck().all(id) as string[]).map(d => JSON.parse(d).T as string | undefined)

async function main() {
  await check('each shape passes the guard; timed alone with a 2 s deadline, the long ones never finish', async () => {
    for (const [pattern, cell, stalls] of SHAPES) {
      assert.equal(validateRegexPattern(pattern), null, pattern)
      const ms = await timed(pattern, cell)
      console.log(`     ${pattern.slice(0, 40).padEnd(40)} on ${cell.length} chars: `
        + (ms === null ? 'stopped at 2 s' : `${ms.toFixed(1)} ms`))
      if (stalls) assert.equal(ms, null, pattern)
    }
  })

  await check('on the worker, each shape that stalls ends at the cap, and the event loop keeps answering', async () => {
    for (const [pattern, cell, stalls] of SHAPES) {
      const pages = regexPages(pattern)
      const t = performance.now()
      try {
        const { out, gap } = await longestGap(() => pages.extract([cell, 'b']).then(r => r, e => e))
        const ms = performance.now() - t
        if (stalls) {
          assert.ok(out instanceof SlowPattern, `${pattern}: ${String(out)}`)
          assert.ok(ms < TRANSFORM_REGEX_PAGE_MS + 1500, `${pattern}: answered after ${ms} ms`)
        } else {
          assert.deepEqual(out, [applyCellOp('regex_extract', cell, { pattern }), applyCellOp('regex_extract', 'b',
            { pattern })], pattern)
        }
        assert.ok(gap < 200, `${pattern}: the event loop waited ${gap} ms`)
      } finally { pages.close() }
    }
  })

  await check('transform_column: a pattern too slow on the first page is refused, and no cell is written',
    async () => {
    const id = sheet(['b1', LONG_A, 'b2'])
    const { out, gap } = await longestGap(() => transformColumn(uid,
      { sheetId: id, operation: 'regex_extract', sourceColumn: 'S', pattern: TWELVE_STARS, targetColumn: 'T' }))
    assert.deepEqual(out, { fail: 'invalid',
      error: `regex_extract stopped: ${SLOW_PATTERN_WHY}. No cell was written. ${SLOW_PATTERN_FIX}` })
    assert.deepEqual(targets(id), [undefined, undefined, undefined])
    assert.ok(gap < 200, `the event loop waited ${gap} ms`)
  })

  await check('transform_column: too slow on a later page, the pages before stay written and the answer says why',
    async () => {
    const cells = Array.from({ length: TRANSFORM_PAGE_ROWS + 50 }, (_, i) => (i === TRANSFORM_PAGE_ROWS + 10
      ? LONG_A : `b${i}`))
    const id = sheet(cells)
    const out = await transformColumn(uid,
      { sheetId: id, operation: 'regex_extract', sourceColumn: 'S', pattern: TWELVE_STARS, targetColumn: 'T' })
    assert.ok('stopped' in out, JSON.stringify(out))
    assert.equal(out.stopped.rows_done, TRANSFORM_PAGE_ROWS)
    assert.match(out.stopped.error, new RegExp(`^Stopped after ${TRANSFORM_PAGE_ROWS} rows: the pattern took more`))
    assert.match(out.stopped.error, /Those rows are written\. .* Then call transform_column with restart: true/)
    const got = targets(id)
    assert.deepEqual(got.slice(0, TRANSFORM_PAGE_ROWS), Array(TRANSFORM_PAGE_ROWS).fill('b'))
    assert.deepEqual(got.slice(TRANSFORM_PAGE_ROWS), Array(50).fill(undefined))
  })

  await check('a pattern that works extracts on the worker what the API thread would, over several pages',
    async () => {
    const cells = Array.from({ length: TRANSFORM_PAGE_ROWS * 2 + 7 }, (_, i) => (i % 3 ? `${i} | B2B` : 'none'))
    const id = sheet(cells)
    const out = await transformColumn(uid,
      { sheetId: id, operation: 'regex_extract', sourceColumn: 'S', pattern: '^(\\d+) \\|', targetColumn: 'T' })
    assert.ok('ok' in out && out.ok.updated === cells.length, JSON.stringify(out))
    assert.deepEqual(targets(id), cells.map(c => applyCellOp('regex_extract', c, { pattern: '^(\\d+) \\|' })))
  })
}

async function changedUnder(changes: number) {
  const id = sheet(['1 x', '2 x', '3 x'])
  let left = changes, n = 0
  afterWorkerRead = () => {
    if (left-- > 0) db.prepare(`UPDATE rows SET data = json_set(data, '$.S', ?) WHERE sheet_id = ? AND row_index = 1`)
      .run(`${20 + n++} x`, id)
  }
  try {
    return { id, out: await transformColumn(uid, { sheetId: id, operation: 'regex_extract', sourceColumn: 'S',
      pattern: '^(\\d+)', targetColumn: 'T' }).catch((e: Error) => e) }
  } finally { afterWorkerRead = null }
}

async function rowsChanging() {
  await check('a row changed after the worker read its page: the page is read again and writes the new value',
    async () => {
    const { id, out } = await changedUnder(1)
    assert.ok(!(out instanceof Error) && 'ok' in out && out.ok.updated === 3, String(out))
    assert.deepEqual(targets(id), ['1', '20', '3'])
  })
  await check('changed every time the worker reads it: the call fails after 3 tries, writing no cell', async () => {
    const { id, out } = await changedUnder(10)
    assert.ok(out instanceof Error, JSON.stringify(out))
    assert.match(out.message, /changed 3 times between working out and writing their values/)
    assert.deepEqual(targets(id), [undefined, undefined, undefined])
  })
}

main()
  .then(rowsChanging)
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-regex-worker assertions passed.')
    process.exit(0)
  })
