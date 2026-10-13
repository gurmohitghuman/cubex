// OpenRouter's in-flight credit budget 402 is refused before the call runs, so
// services/openrouter-retry.ts waits out its Retry-After and tries again; any
// other 402 (an empty balance) is never retried. Bodies are OpenRouter's shape
// (https://openrouter.ai/docs/api_reference/limits).

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import retryMod from '../../server/src/services/openrouter-retry'
// Default import + destructure: Node 22 (CI) can't see named exports of the
// server's CommonJS modules from this ESM test file.
const { inFlightWaitMs, withConnectRetry, errorCauseCode } =
  retryMod as typeof import('../../server/src/services/openrouter-retry')
// The SDK copy the server loads (CommonJS), so instanceof matches its errors.
const { APIError } = createRequire(import.meta.url)('openai') as typeof import('openai')

const IN_FLIGHT = 'This request would exceed your available credits given your current in-flight requests. '
  + 'Retry after in-flight requests settle, or add credits.'
const inFlight = (retryAfter?: string, metadata = true) => APIError.generate(402, {
  error: { code: 402, message: IN_FLIGHT, ...(metadata ? { metadata: { reason: 'in_flight_budget_exhausted' } } : {}) },
}, undefined, retryAfter === undefined ? {} : { 'retry-after': retryAfter })
const broke = () => APIError.generate(402, { error: { code: 402, message: 'Insufficient credits' } }, undefined, {})

// What to wait: Retry-After, bounded; the words alone also count.
assert.equal(inFlightWaitMs(inFlight('3')), 3000)
assert.equal(inFlightWaitMs(inFlight()), 2000, 'no Retry-After: the default wait')
assert.equal(inFlightWaitMs(inFlight('999')), 30_000, 'capped')
assert.equal(inFlightWaitMs(inFlight('0')), 400, 'never a busy loop')
assert.equal(inFlightWaitMs(inFlight('Wed, 21 Oct 2026 07:28:00 GMT')), 2000, 'a date: the default wait')
assert.equal(inFlightWaitMs(inFlight('1', false)), 1000, 'matched by the words without metadata')
assert.equal(inFlightWaitMs(broke()), null, 'an empty balance is not retried')
assert.equal(inFlightWaitMs(APIError.generate(429, { error: { message: 'Rate limited' } }, undefined, {})), null)
assert.equal(inFlightWaitMs(new Error(IN_FLIGHT)), null, 'only an API answer')
const tooBig = APIError.generate(402, {
  error: { code: 402, message: IN_FLIGHT, metadata: { reason: 'weight_exceeds_budget' } },
}, undefined, {})
assert.equal(inFlightWaitMs(tooBig), null, 'another reason: the words alone do not count')
// The reason reaches the saved row error, for the classifier.
assert.equal(errorCauseCode(inFlight('1')), 'in_flight_budget_exhausted')
assert.equal(errorCauseCode(broke()), null)

async function main() {
  // Refused once, then answered.
  let calls = 0
  const out = await withConnectRetry(async () => {
    calls++
    if (calls === 1) throw inFlight('0')
    return 'ok'
  }, undefined, () => false)
  assert.equal(out, 'ok')
  assert.equal(calls, 2)

  // Refused every time: three retries, then the row fails with the refusal.
  calls = 0
  await assert.rejects(withConnectRetry(async () => { calls++; throw inFlight('0') }, undefined, () => false),
    (e: unknown) => e instanceof APIError && e.status === 402)
  assert.equal(calls, 4)

  // An empty balance fails at once.
  calls = 0
  await assert.rejects(withConnectRetry(async () => { calls++; throw broke() }, undefined, () => false))
  assert.equal(calls, 1)

  // A run stopped during the wait sends nothing more.
  calls = 0
  let stopped = false
  await assert.rejects(withConnectRetry(async () => { calls++; stopped = true; throw inFlight('0') },
    undefined, () => stopped))
  assert.equal(calls, 1)

  // An abort ends the wait early and sends nothing more.
  calls = 0
  const ac = new AbortController()
  const started = Date.now()
  const p = withConnectRetry(async () => { calls++; throw inFlight('20') }, ac.signal, () => false)
  setTimeout(() => ac.abort(), 50)
  await assert.rejects(p)
  assert.equal(calls, 1)
  assert.ok(Date.now() - started < 5000, 'the abort ended the wait')
  console.log('openrouter-retry: ok')
}
main().catch(e => { console.error(e); process.exit(1) })
