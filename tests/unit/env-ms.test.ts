// Millisecond settings (lib/env-int.ts envMs): a value past the longest wait Node's timers keep (2^31-1 ms) counts
// as that, with one log line per setting; a normal one, a missing one and a bad one read as before; and the
// server's receive backstop (lib/request-deadline.ts) is at most 2^32-1 ms, the most Node's requestTimeout holds.
import assert from 'node:assert/strict'
import envMod from '../../server/src/lib/env-int'
const { envMs, TIMER_MAX_MS } = envMod as typeof import('../../server/src/lib/env-int')

const warned: string[] = []
console.warn = (m: string) => { warned.push(m) }
process.env.TEST_FAR_MS = String(365 * 24 * 3_600_000)
assert.equal(envMs('TEST_FAR_MS', 1000), TIMER_MAX_MS)
assert.equal(envMs('TEST_FAR_MS', 1000), TIMER_MAX_MS)
assert.equal(warned.length, 1)
assert.match(warned[0], /TEST_FAR_MS is longer than the longest wait Node can keep: using 2147483647 ms/)
console.log('ok   a year counts as 2147483647 ms, said once')
process.env.TEST_OK_MS = '90000'
assert.equal(envMs('TEST_OK_MS', 1000), 90000)
assert.equal(envMs('TEST_MISSING_MS', 1234), 1234)
process.env.TEST_BAD_MS = 'soon'
assert.equal(envMs('TEST_BAD_MS', 1234), 1234)
console.log('ok   a normal, a missing and a bad value read as before')

process.env.REQUEST_BODY_TIMEOUT_MS = String(2 ** 33)
const { receiveBackstopMs, REQUEST_BODY_TIMEOUT_MS } = await import('../../server/src/lib/request-deadline')
assert.equal(REQUEST_BODY_TIMEOUT_MS, TIMER_MAX_MS)
assert.ok(receiveBackstopMs() <= 4_294_967_295, String(receiveBackstopMs()))
console.log('ok   REQUEST_BODY_TIMEOUT_MS past the limit: the deadline and the backstop stay in what Node holds')
console.log('env-ms: all assertions passed')
