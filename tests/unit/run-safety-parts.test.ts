// The parts that keep AI and HTTP API runs bounded, without a database: a
// call's deadline (fires on time, says it was the deadline and not a stop,
// leaves no listener behind), the brake (counts provider failures in a row, a
// row the provider answered resets it, a stop doesn't count), which failures
// are the provider's, a write the database refused for want of space, and the
// slot wait that wakes on a settled row or on its tick.
import assert from 'node:assert/strict'
import deadlineMod from '../../server/src/lib/call-deadline'
import breakerMod from '../../server/src/lib/run-breaker'
import storageMod from '../../server/src/lib/storage-failure'
import poolMod from '../../server/src/lib/run-pool'
import constantsMod from '../../server/src/lib/constants'
const { callDeadline, deadlineWords } = deadlineMod as typeof import('../../server/src/lib/call-deadline')
const { RunBreaker, brakeMessage, aiProviderSide, httpProviderSide, DONE, DROPPED } =
  breakerMod as typeof import('../../server/src/lib/run-breaker')
const { isStorageFailure } = storageMod as typeof import('../../server/src/lib/storage-failure')
const { slotWaiter } = poolMod as typeof import('../../server/src/lib/run-pool')
const { RUN_STOP_POLL_MS } = constantsMod as typeof import('../../server/src/lib/constants')

let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

await ok('a deadline fires on time and says so; a stop is not the deadline', async () => {
  const d = callDeadline(40)
  await sleep(80)
  assert.ok(d.signal.aborted && d.timedOut())
  const parent = new AbortController()
  const s = callDeadline(10_000, parent.signal)
  parent.abort()
  assert.ok(s.signal.aborted && !s.timedOut(), 'the run stopping aborts it, and is not a timeout')
  s.done()
  const early = new AbortController()
  early.abort()
  assert.ok(callDeadline(10_000, early.signal).signal.aborted, 'a run already stopped')
})

await ok('done() drops the timer and the listener on the run signal', async () => {
  const parent = new AbortController()
  const d = callDeadline(30, parent.signal)
  d.done()
  await sleep(60)
  assert.ok(!d.signal.aborted, 'no timer after done')
  parent.abort()
  assert.ok(!d.signal.aborted, 'no listener after done')
  assert.equal(deadlineWords(600_000), '10 minutes')
  assert.equal(deadlineWords(90_000), '90 seconds')
})

await ok('the brake counts provider failures in a row; an answer resets it, a stop does not count', () => {
  const b = new RunBreaker(3)
  const fail = (message: string, provider = true) => b.record({ kind: 'failed', message, provider })
  fail('500 a'); fail('500 b')
  b.record(DROPPED)
  assert.equal(b.tripped, null)
  b.record(DONE)
  fail('500 c'); fail('500 d')
  fail('the prompt was refused', false)
  fail('500 e'); fail('500 f')
  assert.equal(b.tripped, null, 'a failure about the row resets it too')
  fail('500 g')
  assert.deepEqual(b.tripped, { rows: 3, last: '500 g' })
  const words = brakeMessage(b.tripped!, false)
  assert.match(words, /^3 rows in a row failed .*Resume once it works again.*Last error: 500 g$/)
  assert.ok(!words.startsWith('Paused'), "the grid's toast adds that")
  assert.match(brakeMessage(b.tripped!, true), /auto-run stopped; it tries again in a few minutes/)
})

await ok("which AI failures are the provider's or the account's", () => {
  for (const m of ['500 Internal Server Error', 'Connection error. (ECONNRESET)', '401 No auth credentials found',
    '402 Insufficient credits', 'No endpoints found matching your data policy (Free model training)',
    'No answer from the model within 10 minutes (timed out). Re-run the row to try again.']) {
    assert.ok(aiProviderSide(m), m)
  }
  for (const m of ['The model refused to answer', 'Empty response from the model', 'Something odd']) {
    assert.ok(!aiProviderSide(m), m)
  }
})

await ok("which HTTP API failures are the API's", () => {
  assert.ok(httpProviderSide({ kind: 'network' }))
  const status = (s: number) => ({ kind: 'status' as const, status: s, retryAfter: null })
  for (const s of [401, 403, 429, 500, 502, 503]) assert.ok(httpProviderSide(status(s)))
  for (const s of [400, 404, 409, 422]) assert.ok(!httpProviderSide(status(s)))
  assert.ok(!httpProviderSide({ kind: 'other' }))
})

await ok('a database that refuses writes is told apart from a busy one', () => {
  assert.ok(isStorageFailure(Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' })))
  assert.ok(isStorageFailure(Object.assign(new Error('x'), { code: 'SQLITE_IOERR_WRITE' })))
  assert.ok(isStorageFailure(Object.assign(new Error('x'), { code: 'SQLITE_READONLY_DBMOVED' })))
  assert.ok(isStorageFailure(new Error('database or disk is full')))
  assert.ok(!isStorageFailure(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })))
  assert.ok(!isStorageFailure(new Error('UNIQUE constraint failed')))
})

await ok('a full pool wakes when a row settles, or on its tick', async () => {
  const pool = slotWaiter()
  let t = Date.now()
  setTimeout(() => pool.settled(), 20)
  await pool.settledOrTick()
  assert.ok(Date.now() - t < RUN_STOP_POLL_MS / 2, 'woke on the settled row')
  t = Date.now()
  await pool.settledOrTick()
  assert.ok(Date.now() - t >= RUN_STOP_POLL_MS - 50, 'woke on the tick')
})

if (failures) { console.error(`${failures} run-safety-parts assertion(s) failed`); process.exit(1) }
console.log('All run-safety-parts assertions passed.')
