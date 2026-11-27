// sheetFreeWithin (lib/sheet-busy.ts): a test copy holds a sheet with no heavy operation to wait for, so the wait
// looks again every HEAVY_JOB_RETRY_MS instead of on every turn (the thread stays idle, not one core at 100%), gives
// up with what holds the sheet at its limit, and answers null once the hold is gone.
import assert from 'node:assert/strict'
const { sheetFreeWithin } = await import('../../server/src/lib/sheet-busy')
const { holdForTest, releaseTestHold, TESTING } = await import('../../server/src/lib/sheet-test-hold')

const cpuMs = (from: NodeJS.CpuUsage) => { const u = process.threadCpuUsage(from); return (u.user + u.system) / 1000 }
const sheet = crypto.randomUUID()
holdForTest(sheet)
const from = process.threadCpuUsage()
const started = Date.now()
assert.equal(await sheetFreeWithin(sheet, 600), TESTING)
assert.ok(Date.now() - started >= 590, `gave up after ${Date.now() - started} ms`)
// Before, it went round on every turn: about 90 to 110 ms of the thread's CPU in those 600 ms; now one timer.
assert.ok(cpuMs(from) < 30, `${cpuMs(from).toFixed(0)} ms of the thread's CPU while it waited 600 ms`)

setTimeout(() => releaseTestHold(sheet), 100)
assert.equal(await sheetFreeWithin(sheet, 10_000), null)
console.log('All sheet-free-within assertions passed.')
