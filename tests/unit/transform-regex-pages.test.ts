// transform_column's regex_extract, a page's cells at a time on the call's worker (lib/transform-regex-host.ts,
// services/column-transform-pages.ts). A page that runs out of time ends after the rows worked out, and the next
// starts at the row that was running, with the whole time again: a pattern slow on long cells is written, over as
// many calls as it needs. Only a row whose cell alone takes the pattern more than TRANSFORM_REGEX_PAGE_MS stops the
// call, naming the row: refused, writing no cell, when no row of the pass is written; otherwise `stopped`, the rows
// before it written, with the cursor. The event loop keeps answering throughout, a pattern that works extracts what
// the API thread would, and a row changed between the worker's read and the page's transaction is read again.
import assert from 'node:assert/strict'
import { monitorEventLoopDelay } from 'node:perf_hooks'
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
const { applyCellOp } = opsMod as typeof import('../../server/src/lib/transform-ops')
const { SLOW_PATTERN_FIX } = hostMod as typeof import('../../server/src/lib/transform-regex-host')
const { TRANSFORM_MAX_ROWS, TRANSFORM_PAGE_ROWS } = constMod as typeof import('../../server/src/lib/api-v1-constants')
type Params = import('../../server/src/services/column-transform').TransformParams
type Outcome = Awaited<ReturnType<typeof transformColumn>>

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

// Each page's read before its transaction (the rows whose cells go to the worker): counted, and `afterWorkerRead`
// run after it.
let workerReads = 0
let afterWorkerRead: (() => void) | null = null
const prepare = db.prepare.bind(db)
db.prepare = ((sql: string) => {
  const stmt = prepare(sql)
  if (!sql.startsWith('SELECT id, row_index AS ri, data FROM rows')) return stmt
  const all = stmt.all.bind(stmt)
  Object.assign(stmt, { all: (...a: unknown[]) => {
    const rows = all(...a)
    workerReads++
    afterWorkerRead?.()
    return rows
  } })
  return stmt
}) as typeof db.prepare

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const STALLS = `${'a*'.repeat(12)}b`
const STALL_CELL = 'a'.repeat(10_000)

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
const rowId = (id: string, index: number) => db.prepare('SELECT id FROM rows WHERE sheet_id = ? AND row_index = ?')
  .pluck().get(id, index) as string
const extract = (sheetId: string, pattern: string, more: Partial<Params> = {}) =>
  transformColumn(uid, { sheetId, operation: 'regex_extract', sourceColumn: 'S', pattern, targetColumn: 'T', ...more })
const slowWords = (id: string) => `the pattern took more than 1 second on the cell of row ${id}`

// Calls, each with the cursor the one before answered, until one answers without it; every answer.
async function untilEnd(sheetId: string, pattern: string): Promise<Outcome[]> {
  const out = [await extract(sheetId, pattern)]
  for (let o = out[0]; 'ok' in o && o.ok.next_cursor; o = out[out.length - 1]) {
    out.push(await extract(sheetId, pattern, { cursor: o.ok.next_cursor }))
  }
  return out
}

// The longest the event loop waited past its 10 ms timer while `fn` ran, and fn's answer.
async function watched<T>(fn: () => Promise<T>): Promise<{ out: T; lag: number }> {
  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()
  try { return { out: await fn(), lag: h.max / 1e6 - 10 } } finally { h.disable() }
}

async function main() {
  await check('a first row that stalls: refused, naming the row, and no cell is written', async () => {
    const id = sheet([STALL_CELL, 'b1', 'b2'])
    const { out, lag } = await watched(() => extract(id, STALLS))
    assert.deepEqual(out, { fail: 'invalid',
      error: `regex_extract stopped: ${slowWords(rowId(id, 0))}. No cell was written. ${SLOW_PATTERN_FIX}` })
    assert.deepEqual(targets(id), [undefined, undefined, undefined])
    assert.ok(lag < 100, `the event loop waited ${lag} ms`)
  })

  await check('rows written on a page, then the next page\'s first row stalls: stopped, naming it, with the cursor',
    async () => {
    const cells = Array.from({ length: 20 }, (_, i) => (i === 10 ? STALL_CELL : `b${i}`))
    const id = sheet(cells)
    const answers = await untilEnd(id, STALLS)
    console.log(`     stopped in call ${answers.length}`)
    const last = answers[answers.length - 1]
    assert.ok('stopped' in last, JSON.stringify(last))
    assert.equal(last.stopped.rows_done, 10)
    assert.equal(last.stopped.error, `Stopped after 10 rows: ${slowWords(rowId(id, 10))}. Those rows are written. `
      + `${SLOW_PATTERN_FIX} Then call transform_column with restart: true, which works every row out again.`)
    assert.ok(last.stopped.next_cursor)
    assert.deepEqual(targets(id), [...Array(10).fill('b'), ...Array(10).fill(undefined)])
  })

  await check('a call that goes on with a cursor and stalls on its first row: stopped, the pass\'s rows named',
    async () => {
    const id = sheet([...Array.from({ length: TRANSFORM_MAX_ROWS }, (_, i) => `b${i}`), STALL_CELL])
    const t = performance.now()
    const first = await extract(id, STALLS)
    console.log(`     the first call wrote its ${TRANSFORM_MAX_ROWS} rows in ${(performance.now() - t).toFixed(0)} ms`)
    assert.ok('ok' in first && first.ok.updated === TRANSFORM_MAX_ROWS && first.ok.next_cursor, JSON.stringify(first))
    const out = await extract(id, STALLS, { cursor: first.ok.next_cursor })
    assert.ok('stopped' in out, JSON.stringify(out))
    assert.equal(out.stopped.rows_done, TRANSFORM_MAX_ROWS)
    assert.equal(out.stopped.next_cursor, first.ok.next_cursor)
    const stalled = rowId(id, TRANSFORM_MAX_ROWS)
    assert.match(out.stopped.error, new RegExp(`^Stopped after 10,000 rows: ${slowWords(stalled)}\\. Those rows`))
  })

  await check('slow on long cells, not stuck: pages end mid-row, the running row goes first on the next, all written',
    async () => {
    // Each cell about 50 ms, 150 of them: every page runs out of time while a row runs, and that row then has the
    // whole time of the next page.
    const cells = Array.from({ length: 150 }, (_, i) => `${'x'.repeat(5_990)}${String(i).padStart(10, 'y')}`)
    cells.push('name@example.com')
    const id = sheet(cells)
    workerReads = 0
    const { out: answers, lag } = await watched(() => untilEnd(id, '(.*)@'))
    console.log(`     ${answers.length} calls, ${workerReads} pages, the event loop waited at most `
      + `${lag.toFixed(1)} ms`)
    assert.ok(answers.every(a => 'ok' in a), JSON.stringify(answers.find(a => !('ok' in a))))
    assert.equal(answers.reduce((n, a) => n + ('ok' in a ? a.ok.updated : 0), 0), cells.length)
    assert.ok(workerReads > answers.length, `${workerReads} pages in ${answers.length} calls`)
    assert.equal(applyCellOp('regex_extract', cells[0], { pattern: '(.*)@' }), '')
    assert.deepEqual(targets(id), [...Array(150).fill(''), 'name'])
    assert.ok(lag < 100, `the event loop waited ${lag} ms`)
  })

  await check('a pattern that works extracts on the worker what the API thread would, over several pages',
    async () => {
    const cells = Array.from({ length: TRANSFORM_PAGE_ROWS * 2 + 7 }, (_, i) => (i % 3 ? `${i} | B2B` : 'none'))
    const id = sheet(cells)
    const out = await extract(id, '^(\\d+) \\|')
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
    return { id, out: await extract(id, '^(\\d+)').catch((e: Error) => e) }
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
    console.log('All transform-regex-pages assertions passed.')
    process.exit(0)
  })
