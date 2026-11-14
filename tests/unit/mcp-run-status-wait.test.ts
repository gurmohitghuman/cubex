// get_run_status's wait_seconds (services/run-status-wait.ts, statusOnly) through /mcp, under the strict output
// check: a run making steady progress keeps the call waiting the whole time and answers the progress then; a
// finish or a pause ends the wait at once (within the helper's one-second check). The waterfall dry run's own
// wait (no statusOnly) still ends on progress. The helper checks once a second, so "at once" is under 1.6 s.
// Waits have their own slots (lib/long-poll-holds.ts): open sheet tabs and several waits all keep theirs, and
// with the account's 10 taken a call answers at once with waited: false and retry_after_seconds.
import './strict-output'
import assert from 'node:assert/strict'
import dbMod from '../../server/src/lib/db'
import waitMod from '../../server/src/services/run-status-wait'
import holdsMod from '../../server/src/lib/long-poll-holds'
import { mcpHttpKit } from './mcp-http-kit'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { waitForRunChange } = waitMod as typeof import('../../server/src/services/run-status-wait')
const { acquireLongPollHold, releaseLongPollHold, acquireRunWait, MAX_RUN_WAITS_PER_USER } =
  holdsMod as typeof import('../../server/src/lib/long-poll-holds')

const { ctx, check, done, crash, modern } = mcpHttpKit('mcp-run-status-wait')
const u = ctx.userId
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run('t1', u, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position) VALUES (?,?,?,?,0)').run('s1', 't1', u, 'S')
// A running AI run of 100 rows, processed_rows 0.
const newRun = (id: string) => db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status,
  processed_rows,total_rows) VALUES (?,?,?,'Fit','p','running',0,100)`).run(id, 's1', u)
const set = (id: string, fields: string, ...values: unknown[]) =>
  db.prepare(`UPDATE ai_runs SET ${fields} WHERE id = ?`).run(...values, id)
// 10 rows more every 250 ms until stopped, as a steady run does.
const steady = (id: string) => {
  let n = 0
  const timer = setInterval(() => { n = Math.min(100, n + 10); set(id, 'processed_rows = ?', n) }, 250)
  return () => clearInterval(timer)
}
const status = async (id: string, wait: number) => {
  const started = performance.now()
  const res = await modern('tools/call', { name: 'get_run_status',
    arguments: { run_type: 'ai', run_id: id, wait_seconds: wait } }, 'get_run_status')
  const result = JSON.parse(res.text).result
  assert.ok(!result.isError, res.text)
  const run = result.structuredContent as {
    status: string; processed_rows: number; waited?: boolean; retry_after_seconds?: number
  }
  return { run, ms: performance.now() - started }
}

try {
  await check('a steady run keeps get_run_status waiting the whole time, then answers its progress', async () => {
    newRun('r1')
    const stop = steady('r1')
    const { run, ms } = await status('r1', 3)
    stop()
    assert.ok(ms >= 2900, `answered after ${ms.toFixed(0)} ms`)
    assert.equal(run.status, 'running')
    assert.ok(run.processed_rows >= 50, `progress ${run.processed_rows}`)
  })
  await check('a finish ends the wait at once', async () => {
    newRun('r2')
    setTimeout(() => set('r2', "status = 'completed', processed_rows = 100"), 300)
    const { run, ms } = await status('r2', 3)
    assert.ok(ms < 1600, `answered after ${ms.toFixed(0)} ms`)
    assert.equal(run.status, 'completed')
    assert.equal(run.processed_rows, 100)
  })
  await check('a pause ends the wait at once, even while rows still move', async () => {
    newRun('r3')
    const stop = steady('r3')
    setTimeout(() => set('r3', "status = 'paused'"), 300)
    const { run, ms } = await status('r3', 3)
    stop()
    assert.ok(ms < 1600, `answered after ${ms.toFixed(0)} ms`)
    assert.equal(run.status, 'paused')
  })
  await check('the waterfall dry run\'s wait (no statusOnly) still ends on progress', async () => {
    newRun('r4')
    setTimeout(() => set('r4', 'processed_rows = 10'), 300)
    const started = performance.now()
    const { run, noSlot } = await waitForRunChange('ai', 'r4', u, 3)
    const ms = performance.now() - started
    assert.ok(ms < 1600, `answered after ${ms.toFixed(0)} ms`)
    assert.equal(run?.processed_rows, 10)
    assert.equal(noSlot, undefined)
  })
  await check('two open tabs and five waits: every wait waits, and the tabs still get their six slots', async () => {
    const tabs = [acquireLongPollHold(u), acquireLongPollHold(u)]
    const ids = ['w1', 'w2', 'w3', 'w4', 'w5']
    ids.forEach(newRun)
    const follows = Promise.all(ids.map(id => status(id, 3)))
    await new Promise(resolve => setTimeout(resolve, 500))
    for (let i = 0; i < 4; i++) tabs.push(acquireLongPollHold(u))
    const seventh = acquireLongPollHold(u)
    const answers = await follows
    tabs.filter(Boolean).forEach(() => releaseLongPollHold(u))
    if (seventh) releaseLongPollHold(u)
    assert.deepEqual(tabs, [true, true, true, true, true, true])
    assert.equal(seventh, false, 'a seventh tab got a slot')
    for (const { run, ms } of answers) {
      assert.ok(ms >= 2900, `a wait answered after ${ms.toFixed(0)} ms`)
      assert.equal(run.waited, undefined)
    }
  })
  await check(`with ${MAX_RUN_WAITS_PER_USER} waits open, a call answers at once with waited false and when to call`
    + ' again', async () => {
    newRun('r5')
    const held = Array.from({ length: MAX_RUN_WAITS_PER_USER }, () => acquireRunWait(u, 20))
    try {
      assert.ok(held.every(h => 'release' in h), 'the account\'s waits were not all free')
      const { run, ms } = await status('r5', 3)
      assert.ok(ms < 1000, `answered after ${ms.toFixed(0)} ms`)
      assert.equal(run.status, 'running')
      assert.equal(run.waited, false)
      assert.ok(run.retry_after_seconds! >= 19 && run.retry_after_seconds! <= 20, `${run.retry_after_seconds}`)
    } finally { for (const h of held) if ('release' in h) h.release() }
    const after = await status('r5', 1)
    assert.equal(after.run.waited, undefined, 'a slot freed is used again')
    assert.ok(after.ms >= 900, `answered after ${after.ms.toFixed(0)} ms`)
  })
  done()
} catch (e) { crash(e) }
