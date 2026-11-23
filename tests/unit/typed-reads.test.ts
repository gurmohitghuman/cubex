// A box's reads as a person types or clicks (client/src/lib/typedReads.ts): a read TYPING_WAIT_MS after the last
// change, one read of the box at a time, the newest text read once the one on its way ends, an older answer never
// shown, and a heavy read paced by its own time. A fake clock: no DB, no network, no waiting.
import assert from 'node:assert/strict'
import { TypedReads, type ReadAnswer, type TypedReadOptions } from '../../client/src/lib/typedReads'
import { TYPING_WAIT_MS } from '../../client/src/lib/constants'
import { FakeClock } from './fake-clock'

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ok  ${label}`) } catch (e) {
    failures++
    console.error(`  FAIL ${label}\n${(e as Error).message}`)
  }
}

type Run = { key: string; start: number; end: number | null; aborted: boolean }

// A box whose read of `key` takes `cost(key)` ms (fails when `fail(key)`), logging each read and each answer shown.
function box(cost: (key: string) => number, opts: TypedReadOptions = {}, fail = (_k: string) => false) {
  const clock = new FakeClock()
  const runs: Run[] = []
  const shown: Array<ReadAnswer<string> & { at: number }> = []
  const reads = new TypedReads<string>(a => shown.push({ ...a, at: clock.t }), opts, clock)
  const type = (key: string) => reads.ask(key, signal => {
    const run: Run = { key, start: clock.t, end: null, aborted: false }
    runs.push(run)
    signal.addEventListener('abort', () => { run.aborted = true })
    return new Promise<string>((resolve, reject) => {
      clock.setTimeout(() => {
        run.end = clock.t
        if (fail(key)) reject(new Error(`no ${key}`)); else resolve(`answer for ${key}`)
      }, cost(key))
    })
  })
  return { clock, runs, shown, reads, type }
}

const overlapping = (runs: Run[]) =>
  runs.some((r, i) => i > 0 && (runs[i - 1].end === null || r.start < runs[i - 1].end!))

// Types `text` one key every `gapMs`, from `from`, as a person would.
async function typeOut(b: ReturnType<typeof box>, text: string, gapMs: number, from = 0) {
  for (let i = 1; i <= text.length; i++) {
    await b.clock.advanceTo(from + (i - 1) * gapMs)
    b.type(text.slice(0, i))
  }
}

async function main() {
  await check('a read starts TYPING_WAIT_MS after the last key, and keys closer than that start none', async () => {
    const b = box(() => 50)
    await typeOut(b, 'acme', 100)
    await b.clock.advanceTo(300 + TYPING_WAIT_MS - 1)
    assert.equal(b.runs.length, 0)
    await b.clock.advanceTo(300 + TYPING_WAIT_MS)
    assert.deepEqual(b.runs.map(r => [r.key, r.start]), [['acme', 300 + TYPING_WAIT_MS]])
    await b.clock.advanceTo(2_000)
    assert.deepEqual(b.shown.map(a => a.ok && a.value), ['answer for acme'])
  })

  await check('keys during a read start none: once it ends, its answer is dropped and the newest text is read once',
    async () => {
      const b = box(() => 1_000)
      b.type('a')
      await b.clock.advanceTo(TYPING_WAIT_MS + 100)
      b.type('ab')
      await b.clock.advanceTo(TYPING_WAIT_MS + 400)
      b.type('abc')
      await b.clock.advanceTo(TYPING_WAIT_MS + 999)
      assert.equal(b.runs.length, 1, 'no second read while the first is on its way')
      await b.clock.advanceTo(10_000)
      assert.deepEqual(b.runs.map(r => r.key), ['a', 'abc'])
      assert.equal(b.runs[1].start, TYPING_WAIT_MS + 1_000, 'the newest text, as soon as the first read ended')
      assert.deepEqual(b.shown.map(a => a.ok && a.value), ['answer for abc'])
      assert.ok(!b.runs[0].aborted, 'the first read is let finish, as the server would')
    })

  await check('a typist 230 ms a key: reads never overlap, and only the final text\'s answer shows last', async () => {
    for (const cost of [20, 150, 600, 2_000]) {
      const b = box(() => cost)
      await typeOut(b, 'acme corporation', 230)
      await b.clock.advanceTo(60_000)
      assert.ok(!overlapping(b.runs), `${cost} ms reads overlapped`)
      assert.equal(b.shown.at(-1)?.key, 'acme corporation', `${cost} ms`)
      assert.equal(b.runs.at(-1)?.key, 'acme corporation', `${cost} ms`)
      for (const a of b.shown) {
        const asked = b.runs.find(r => r.key === a.key)!
        assert.ok(a.at === asked.end, 'each answer shows when its own read ends')
      }
    }
  })

  await check('an older answer never shows over a newer one', async () => {
    const b = box(k => (k === 'a' ? 3_000 : 100))
    b.type('a')
    await b.clock.advanceTo(TYPING_WAIT_MS + 10)
    b.type('ab')
    await b.clock.advanceTo(20_000)
    assert.deepEqual(b.shown.map(a => a.key), ['ab'])
  })

  await check('typing back to the text on its way shows its answer, with no second read', async () => {
    const b = box(() => 1_000)
    b.type('acme')
    await b.clock.advanceTo(TYPING_WAIT_MS + 10)
    b.type('acm')
    await b.clock.advanceTo(TYPING_WAIT_MS + 100)
    b.type('acme')
    await b.clock.advanceTo(10_000)
    assert.deepEqual(b.runs.map(r => r.key), ['acme'])
    assert.deepEqual(b.shown.map(a => a.key), ['acme'])
  })

  await check('nothing to read (an emptied box, an answer at hand): the read on its way ends unseen', async () => {
    const b = box(() => 1_000)
    b.type('acme')
    await b.clock.advanceTo(TYPING_WAIT_MS + 10)
    b.reads.ask('', null)
    await b.clock.advanceTo(10_000)
    assert.equal(b.runs.length, 1)
    assert.deepEqual(b.shown, [])
  })

  await check('a failed read answers its error, for its own text only', async () => {
    const b = box(() => 100, {}, k => k.startsWith('bad'))
    b.type('bad')
    await b.clock.advanceTo(5_000)
    assert.equal(b.shown.length, 1)
    const first = b.shown[0]
    assert.ok(!first.ok && (first.error as Error).message === 'no bad')
    b.type('good')
    await b.clock.advanceTo(10_000)
    assert.deepEqual(b.shown.map(a => (a.ok ? a.value : 'error')), ['error', 'answer for good'])
  })

  await check('paced: the next read starts no sooner than the last one\'s own time after it ended', async () => {
    const b = box(() => 2_000, { paced: true })
    b.type('a')
    await b.clock.advanceTo(TYPING_WAIT_MS + 1)
    b.type('ab')
    await b.clock.advanceTo(30_000)
    assert.deepEqual(b.runs.map(r => [r.key, r.start]), [['a', TYPING_WAIT_MS], ['ab', TYPING_WAIT_MS + 4_000]])
    const p = box(() => 2_000)
    p.type('a')
    await p.clock.advanceTo(TYPING_WAIT_MS + 1)
    p.type('ab')
    await p.clock.advanceTo(30_000)
    assert.equal(p.runs[1].start, TYPING_WAIT_MS + 2_000, 'not paced: as soon as the first ended')
  })

  await check('paced, a typist on a slow whole-sheet read: the server is busy at most half the time', async () => {
    for (const cost of [300, 1_500, 5_000]) {
      const b = box(() => cost, { paced: true })
      await typeOut(b, 'status is not empty and company contains acme', 230)
      await b.clock.advanceTo(120_000)
      const first = b.runs[0].start, last = b.runs.at(-1)!.end!
      const busy = b.runs.reduce((s, r) => s + (r.end! - r.start), 0)
      assert.ok(!overlapping(b.runs), `${cost} ms overlapped`)
      assert.ok(busy <= (last - first) / 2 + cost, `${cost} ms: busy ${busy} of ${last - first}`)
      assert.equal(b.shown.at(-1)?.key, 'status is not empty and company contains acme')
    }
  })

  await check('a choice made by clicking (waitMs 0) reads at once; a burst of clicks makes at most two reads',
    async () => {
      const b = box(() => 300, { waitMs: 0 })
      b.type('exa')
      assert.deepEqual(b.runs.map(r => [r.key, r.start]), [['exa', 0]])
      await b.clock.advanceTo(50)
      b.type('google')
      await b.clock.advanceTo(100)
      b.type('bing')
      await b.clock.advanceTo(5_000)
      assert.deepEqual(b.runs.map(r => r.key), ['exa', 'bing'])
      assert.deepEqual(b.shown.map(a => a.key), ['bing'])
    })

  await check('closing the box aborts the read on its way and answers nothing more', async () => {
    const b = box(() => 1_000)
    b.type('acme')
    await b.clock.advanceTo(TYPING_WAIT_MS + 10)
    b.reads.stop()
    b.type('acme2')
    await b.clock.advanceTo(10_000)
    assert.equal(b.runs.length, 1)
    assert.ok(b.runs[0].aborted)
    assert.deepEqual(b.shown, [])
  })

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
  console.log('\nall typed-read checks passed')
}

void main()
