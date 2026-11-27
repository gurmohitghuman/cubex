// transform_column's regex_extract runs on a worker thread, a page's cells at a time (lib/transform-regex-host.ts).
// Patterns the guard passes, because no group repeats a quantifier, still backtrack for hours on a long cell, and
// one unbounded part on a long cell with no match is slow, not stuck: each shape is first timed on its own worker
// with a hard 2 s deadline (never on the API thread), and the times are printed. Through the host, the worker
// answers each cell as it works it out: a page that runs out of time keeps the cells finished, the next extract
// starts a new worker with the whole time again, and one that stalls on its first cell answers none. Meanwhile the
// event loop keeps answering: this thread never waits for the worker (sync-waits.ts), and its CPU time in any one
// stretch stays under 100 ms (loop-watch.ts cpuMs), so the pattern isn't run here; the loop's longest stretch is
// printed, not bounded, as a busy machine stretches it. The calls through transform_column:
// transform-regex-pages.test.ts.
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import opsMod from '../../server/src/lib/transform-ops'
import hostMod from '../../server/src/lib/transform-regex-host'
import constMod from '../../server/src/lib/api-v1-constants'
import { watchWhile } from './loop-watch'
import { countSyncWaits } from './sync-waits'
import { passed } from './ends-on-its-own'
const { applyCellOp, validateRegexPattern } = opsMod as typeof import('../../server/src/lib/transform-ops')
const { regexPages } = hostMod as typeof import('../../server/src/lib/transform-regex-host')
const { TRANSFORM_REGEX_PAGE_MS } = constMod as typeof import('../../server/src/lib/api-v1-constants')

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const A28 = 'a'.repeat(28)
const LONG_A = 'a'.repeat(10_000)
const DIGITS = '1'.repeat(10_000)
const TWELVE_STARS = `${'a*'.repeat(12)}b`
// [pattern, cell, stalls]: every one passes the guard. The ones that stall take minutes or more on their cell; the
// others take at most about 200 ms.
const SHAPES: Array<[string, string, boolean]> = [
  ['(a?){28}a{28}', A28, false],
  [`${'a?'.repeat(28)}${'a'.repeat(28)}`, A28, false],
  [TWELVE_STARS, LONG_A, true],
  ['\\d+\\d+b', DIGITS, true],
  ['\\d{0,200}\\d{0,200}\\d{0,200}b', DIGITS, true],
  ['\\d+b', DIGITS, false],
  ['(.*)@', 'x'.repeat(10_000), false],
  ['(.*)@', 'x'.repeat(3_000), false],
  ['(\\S+@\\S+)', 'x'.repeat(2_000), false],
  ['^(.*)@', 'x'.repeat(10_000), false],
]
const STALLS = SHAPES.filter(([, , stalls]) => stalls)

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

// While `fn` ran: the longest this thread alone held the event loop (printed), the most CPU it spent in one stretch,
// and how many times it waited on another thread (loop-watch.ts, sync-waits.ts); fn's answer and time.
async function watched<T>(fn: () => Promise<T>): Promise<{ out: T; lag: number; cpu: number; waits: number;
  ms: number }> {
  const { out: { out, ms, watched: w }, waits } = await countSyncWaits(() => watchWhile(() => [], fn))
  return { out, ms, lag: w.ownMs, cpu: w.cpuMs, waits }
}

async function main() {
  await check('the count of this thread\'s waits sees one', async () => {
    const seen = await countSyncWaits(async () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1) })
    assert.equal(seen.waits, 1)
  })

  await check('each shape passes the guard; timed alone with a 2 s deadline, the stalling ones never finish',
    async () => {
    for (const [pattern, cell, stalls] of SHAPES) {
      assert.equal(validateRegexPattern(pattern), null, pattern)
      const ms = await timed(pattern, cell)
      console.log(`     ${pattern.slice(0, 40).padEnd(40)} on ${String(cell.length).padStart(6)} chars: `
        + (ms === null ? 'stopped at 2 s' : `${ms.toFixed(1)} ms`))
      assert.equal(ms === null, stalls, pattern)
    }
  })

  await check('a cell that stalls first: the page answers no cell, at the time cap, the event loop free', async () => {
    for (const [pattern, cell] of STALLS) {
      const pages = regexPages(pattern)
      try {
        await pages.extract(['b'])
        const { out, ms, lag, cpu, waits } = await watched(() => pages.extract([cell, 'b']))
        console.log(`     ${pattern.slice(0, 40).padEnd(40)} no cell after ${ms.toFixed(0)} ms, the event loop `
          + `waited at most ${lag.toFixed(1)} ms (on the CPU at most ${cpu.toFixed(1)} ms in one stretch)`)
        assert.deepEqual(out, [], pattern)
        assert.ok(ms >= TRANSFORM_REGEX_PAGE_MS - 50 && ms < 6000, `${pattern}: answered after ${ms} ms`)
        assert.equal(waits, 0, `${pattern}: this thread waited on another`)
        assert.ok(cpu < 100, `${pattern}: this thread was on the CPU ${cpu.toFixed(0)} ms in one stretch`)
      } finally { pages.close() }
    }
  })

  await check('a cell that stalls later: the page keeps the cells before it, and the next page gets a new worker',
    async () => {
    for (const [pattern, cell] of STALLS) {
      const pages = regexPages(pattern)
      const quick = ['b', '1b', 'xb']
      try {
        const { out } = await watched(() => pages.extract([...quick, cell, 'b']))
        assert.deepEqual(out, quick.map(v => applyCellOp('regex_extract', v, { pattern })), pattern)
        // The stalled cell's worker was stopped: a page after it is worked out by another.
        assert.deepEqual(await pages.extract(['b', '11b']),
          ['b', '11b'].map(v => applyCellOp('regex_extract', v, { pattern })), pattern)
      } finally { pages.close() }
    }
  })

  await check('the shapes that finish give on the worker what they give on the API thread', async () => {
    for (const [pattern, cell] of SHAPES.filter(([, , stalls]) => !stalls)) {
      const pages = regexPages(pattern)
      const values = [cell, `${cell.slice(0, 20)}@x y`, 'b', '']
      try {
        assert.deepEqual(await pages.extract(values), values.map(v => applyCellOp('regex_extract', v, { pattern })))
      } finally { pages.close() }
    }
  })

  await check('closed, the host refuses another page, and closing twice is safe', async () => {
    const pages = regexPages('(\\d+)')
    assert.deepEqual(await pages.extract(['a1']), ['1'])
    pages.close()
    pages.close()
    await assert.rejects(pages.extract(['a2']), /regex worker is closed/)
  })
}

main()
  .catch(e => { failures++; console.log('FAIL threw', e) })
  .finally(() => {
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
    console.log('All transform-regex-worker assertions passed.')
    passed()
  })
