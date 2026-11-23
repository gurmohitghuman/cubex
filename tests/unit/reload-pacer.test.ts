// An open tab's background reloads, paced by their own cost (client/src/hooks/sheet/reloadPacer.ts): the first
// change after quiet reloads at once, one reload at a time, a rest of 4x the last reload's time (1 to 15 s) after
// each, and every change shown by a reload that starts after it. A fake clock: no DB, no network, no waiting.
import assert from 'node:assert/strict'
import {
  ReloadPacer, reloadRest, RELOAD_REST_MAX_MS, RELOAD_REST_MIN_MS, RELOAD_WAIT_MAX_MS,
} from '../../client/src/hooks/sheet/reloadPacer'
import { FakeClock } from './fake-clock'

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ok  ${label}`) } catch (e) {
    failures++
    console.error(`  FAIL ${label}\n${(e as Error).message}`)
  }
}

// A sheet whose reload takes `cost(n)` ms on the fake clock, logging when each one ran.
function sheet(cost: (n: number) => number, fail = false) {
  const clock = new FakeClock()
  const runs: Array<{ start: number; end: number | null }> = []
  const pacer = new ReloadPacer(() => {
    const run = { start: clock.t, end: null as number | null }
    runs.push(run)
    return new Promise<void>((resolve, reject) => {
      clock.setTimeout(() => { run.end = clock.t; if (fail) reject(new Error('offline')); else resolve() },
        cost(runs.length))
    })
  }, clock)
  return { clock, runs, pacer }
}

const overlapping = (runs: Array<{ start: number; end: number | null }>) =>
  runs.some((r, i) => i > 0 && (runs[i - 1].end === null || r.start < runs[i - 1].end!))

async function main() {
  await check('the rest: 4x the reload\'s time, at least 1 s, at most 15 s', () => {
    assert.deepEqual([0, 100, 1_000, 60_000].map(reloadRest), [RELOAD_REST_MIN_MS, 1_000, 4_000, RELOAD_REST_MAX_MS])
  })

  await check('the first change after quiet reloads at once; sheets are paced apart', async () => {
    const { clock, runs, pacer } = sheet(() => 80)
    clock.t = 50_000
    pacer.request('s')
    pacer.request('other')
    assert.deepEqual(runs.map(r => r.start), [50_000, 50_000])
  })

  await check('changes during a reload: one more reload after it, after its rest, showing them all', async () => {
    const { clock, runs, pacer } = sheet(() => 300)
    pacer.request('s')
    await clock.advanceTo(100)
    for (let n = 0; n < 3; n++) pacer.request('s')
    await clock.advanceTo(10_000)
    // 4 x 300 ms after the first one ended.
    assert.deepEqual(runs.map(r => r.start), [0, 300 + 1_200])
  })

  await check('a change during the rest waits for its end; more changes then add nothing', async () => {
    const { clock, runs, pacer } = sheet(() => 50)
    pacer.request('s')
    await clock.advanceTo(200)
    pacer.request('s')
    await clock.advanceTo(600)
    pacer.request('s')
    await clock.advanceTo(5_000)
    assert.deepEqual(runs.map(r => r.start), [0, 50 + 1_000])
  })

  // A writer changing the sheet twice a second for 2 minutes, at three reload costs.
  for (const cost of [100, 1_000, 3_000]) {
    await check(`a writer for 2 minutes, reloads of ${cost} ms: never two at once, busy at most a fifth`, async () => {
      const { clock, runs, pacer } = sheet(() => cost)
      for (let at = 0; at < 120_000; at += 500) {
        await clock.advanceTo(at)
        pacer.request('s')
      }
      await clock.advanceTo(200_000)
      assert.equal(overlapping(runs), false)
      for (let i = 1; i < runs.length; i++) assert.ok(runs[i].start - runs[i - 1].start >= 1_000, 'one a second')
      // Each reload and the rest after it, up to the last reload's start.
      const busy = runs.slice(0, -1).reduce((ms, r) => ms + (r.end! - r.start), 0)
      const span = runs[runs.length - 1].start - runs[0].start
      assert.ok(runs.length > 5 && busy / span <= 0.2 + 1e-9, `busy ${busy} of ${span} ms`)
      // The last change (at 119.5 s) is shown by a reload that starts after it, within a rest and a reload.
      const last = runs[runs.length - 1]
      assert.ok(last.start >= 119_500, `last reload at ${last.start}`)
      assert.ok(last.start <= 119_500 + cost + reloadRest(cost), `last reload at ${last.start}`)
    })
  }

  await check('a slow reload (5 s) rests 15 s, not more: today\'s gap', async () => {
    const { clock, runs, pacer } = sheet(() => 5_000)
    for (let at = 0; at < 60_000; at += 500) {
      await clock.advanceTo(at)
      pacer.request('s')
    }
    await clock.advanceTo(120_000)
    assert.equal(overlapping(runs), false)
    for (let i = 1; i < runs.length; i++) assert.equal(runs[i].start - runs[i - 1].end!, RELOAD_REST_MAX_MS)
  })

  await check('the rest follows the last reload: a fast one after a slow one shortens it', async () => {
    const { clock, runs, pacer } = sheet(n => (n === 1 ? 2_000 : 100))
    pacer.request('s')
    await clock.advanceTo(500)
    pacer.request('s')
    await clock.advanceTo(20_000)
    pacer.request('s')
    await clock.advanceTo(40_000)
    assert.equal(runs.length, 3)
    assert.equal(runs[1].start, 2_000 + 8_000)
    // The second took 100 ms: the third waits only 1 s after it, and starts at once here.
    assert.equal(runs[2].start, 20_000)
  })

  await check('cancel drops the waiting reload and says it did; nothing waiting: false', async () => {
    const { clock, runs, pacer } = sheet(() => 100)
    assert.equal(pacer.cancel('s'), false)
    pacer.request('s')
    await clock.advanceTo(300)
    pacer.request('s') // waits for the rest
    assert.equal(pacer.cancel('s'), true)
    await clock.advanceTo(5_000)
    assert.equal(runs.length, 1)
    // One more after the reload running: dropped too.
    pacer.request('s')
    await clock.advanceTo(5_050)
    pacer.request('s')
    assert.equal(pacer.cancel('s'), true)
    await clock.advanceTo(20_000)
    assert.equal(runs.length, 2)
    assert.equal(pacer.cancel('s'), false)
  })

  await check('a failed reload keeps the pace going', async () => {
    const { clock, runs, pacer } = sheet(() => 100, true)
    pacer.request('s')
    await clock.advanceTo(50)
    pacer.request('s')
    await clock.advanceTo(10_000)
    assert.equal(runs.length, 2)
    assert.equal(runs[1].start, 100 + 1_000)
  })

  await check('a reload that never ends holds the pace 5 minutes at most', async () => {
    const { clock, runs, pacer } = sheet(n => (n === 1 ? Infinity : 100))
    pacer.request('s')
    await clock.advanceTo(1_000)
    pacer.request('s')
    await clock.advanceTo(RELOAD_WAIT_MAX_MS - 1)
    assert.equal(runs.length, 1)
    await clock.advanceTo(RELOAD_WAIT_MAX_MS + RELOAD_REST_MAX_MS + 1_000)
    assert.deepEqual(runs.map(r => r.start), [0, RELOAD_WAIT_MAX_MS + RELOAD_REST_MAX_MS])
  })

  await check('stopped: no reload, not even one waiting', async () => {
    const { clock, runs, pacer } = sheet(() => 100)
    pacer.request('s')
    await clock.advanceTo(200)
    pacer.request('s')
    pacer.stop()
    await clock.advanceTo(10_000)
    pacer.request('s')
    await clock.advanceTo(20_000)
    assert.equal(runs.length, 1)
  })
}

void main().then(() => {
  if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1) }
  console.log('\nAll reload-pacer checks passed.')
})
