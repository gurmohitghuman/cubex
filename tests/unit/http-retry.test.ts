// HTTP API column retries (lib/http-retry.ts), pure: which failures are tried
// again for which methods, how Retry-After is read and capped, how the wait
// grows, and that a wait ends early when the run stops.
import retryMod from '../../server/src/lib/http-retry'
import errMod from '../../server/src/lib/http-errors'
import constMod from '../../server/src/lib/constants-http-retry'
const {
  retryPolicyOf, isRetryable, parseRetryAfter, retryWaitMs, nextRetryWait, tryFailureOf, waitUnlessStopped,
} = retryMod as typeof import('../../server/src/lib/http-retry')
const {
  UpstreamStatusError, NetworkError, OutboundBlockedError, withResponseStatus, responseStatusOf, isTransportFailure,
} =
  errMod as typeof import('../../server/src/lib/http-errors')
const { HTTP_RETRY_BASE_MS, HTTP_RETRY_MAX_WAIT_MS, HTTP_RETRY_DEFAULT } =
  constMod as typeof import('../../server/src/lib/constants-http-retry')

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const status = (s: number, retryAfter: string | null = null) => ({ kind: 'status' as const, status: s, retryAfter })
const network = { kind: 'network' as const }
const other = { kind: 'other' as const }

// --- The policy a stored config asks for ---
check('no retries field: the default', retryPolicyOf({}).retries === HTTP_RETRY_DEFAULT && HTTP_RETRY_DEFAULT === 3)
check('0 turns it off', retryPolicyOf({ retries: 0 }).retries === 0)
check('above 5 is held at 5', retryPolicyOf({ retries: 9 }).retries === 5)
check('a negative is held at 0', retryPolicyOf({ retries: -2 }).retries === 0)
check('a non-integer takes the default', retryPolicyOf({ retries: 2.5 }).retries === 3)
check('retryPost only when true', retryPolicyOf({ retryPost: 'yes' }).retryPost === false
  && retryPolicyOf({ retryPost: true }).retryPost === true)

// --- What is retried, by method ---
for (const m of ['GET', 'HEAD', 'PUT', 'DELETE', 'POST', 'PATCH']) {
  check(`429 is retried for ${m}`, isRetryable(status(429), m, false))
  check(`503 is retried for ${m}`, isRetryable(status(503), m, false))
}
for (const s of [500, 502, 504, 599]) {
  check(`${s} is retried for GET and PUT`, isRetryable(status(s), 'GET', false) && isRetryable(status(s), 'put', false))
  check(`${s} is not retried for POST`, !isRetryable(status(s), 'POST', false))
  check(`${s} is retried for POST with retryPost`, isRetryable(status(s), 'POST', true))
}
check('501 and 505 are never retried', !isRetryable(status(501), 'GET', true) && !isRetryable(status(505), 'GET', true))
for (const s of [400, 401, 403, 404, 408, 409, 410, 422]) {
  check(`${s} is never retried`, !isRetryable(status(s), 'GET', true))
}
check('a 3xx is never retried', !isRetryable(status(302), 'GET', true))
check('no answer is retried for GET/HEAD/PUT/DELETE',
  ['GET', 'HEAD', 'PUT', 'DELETE'].every(m => isRetryable(network, m, false)))
check('no answer is not retried for POST', !isRetryable(network, 'POST', false))
check('no answer is retried for POST and PATCH with retryPost', isRetryable(network, 'POST', true)
  && isRetryable(network, 'PATCH', true))
check('other failures are never retried', !isRetryable(other, 'GET', true))

// --- Typed errors map to failures ---
check('UpstreamStatusError → status + Retry-After',
  JSON.stringify(tryFailureOf(new UpstreamStatusError(429, '3', 'HTTP 429 from upstream')))
    === JSON.stringify(status(429, '3')))
check('NetworkError → network', tryFailureOf(new NetworkError('connect ECONNREFUSED')).kind === 'network')
check('a blocked URL → other', tryFailureOf(new OutboundBlockedError('private address')).kind === 'other')
check('a plain Error → other', tryFailureOf(new Error('{{x}} doesn\'t match a column')).kind === 'other')
check('an UpstreamStatusError carries its status', responseStatusOf(new UpstreamStatusError(404, null, 'x')) === 404)
check('withResponseStatus marks any error', responseStatusOf(withResponseStatus(new Error('not JSON'), 200)) === 200)
check('a plain error has no status', responseStatusOf(new Error('x')) === null && responseStatusOf(null) === null)
const coded = (code: string, cause = false) => Object.assign(new Error('x'), cause ? { cause: { code } } : { code })
for (const code of ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'EAI_AGAIN']) {
  check(`${code} is a transport failure`, isTransportFailure(coded(code)) && isTransportFailure(coded(code, true)))
}
check('a bad argument (a header with a line break) is not', !isTransportFailure(coded('UND_ERR_INVALID_ARG')))
check('a plain error is not', !isTransportFailure(new Error('x')) && !isTransportFailure(null))

// --- Retry-After ---
const now = Date.parse('2026-10-17T12:00:00Z')
check('seconds', parseRetryAfter('3', now) === 3000)
check('decimal seconds', parseRetryAfter(' 1.5 ', now) === 1500)
check('an HTTP date', parseRetryAfter('Sat, 17 Oct 2026 12:00:10 GMT', now) === 10_000)
check('a date in the past is 0', parseRetryAfter('Sat, 17 Oct 2026 11:00:00 GMT', now) === 0)
check('junk, empty and absent are null', parseRetryAfter('soon', now) === null && parseRetryAfter('', now) === null
  && parseRetryAfter(null, now) === null && parseRetryAfter(undefined, now) === null)
check('a negative number is junk, not a date', parseRetryAfter('-5', now) === null)
check('bare digits are always seconds, never a year', parseRetryAfter('7', now) === 7000
  && parseRetryAfter('2026', now) === 2_026_000)

// --- The wait ---
const fixed = (v: number) => () => v
check('Retry-After is followed', retryWaitMs(status(429, '2'), 1, now, fixed(0)) === 2000)
check('Retry-After gets at most 10% jitter, capped at 1 s',
  retryWaitMs(status(429, '2'), 1, now, fixed(0.999)) <= 2200
    && retryWaitMs(status(429, '30'), 1, now, fixed(0.999)) <= 31_000)
check('Retry-After is capped at 60 s', retryWaitMs(status(503, '3600'), 1, now, fixed(0.5)) === HTTP_RETRY_MAX_WAIT_MS
  && HTTP_RETRY_MAX_WAIT_MS === 60_000)
check('an unreadable Retry-After falls back to the backoff', retryWaitMs(status(503, 'later'), 1, now, fixed(0))
  === Math.round(HTTP_RETRY_BASE_MS / 2))
for (let attempt = 1; attempt <= 5; attempt++) {
  const step = Math.min(HTTP_RETRY_BASE_MS * 2 ** (attempt - 1), HTTP_RETRY_MAX_WAIT_MS)
  const lo = retryWaitMs(status(500), attempt, now, fixed(0)), hi = retryWaitMs(status(500), attempt, now, fixed(1))
  check(`try ${attempt + 1} waits between half and all of ${step} ms`, lo === Math.round(step / 2) && hi === step,
    { lo, hi })
}
check('the backoff never passes the cap', retryWaitMs(network, 40, now, fixed(1)) === HTTP_RETRY_MAX_WAIT_MS)

// --- Next try, with the column's retries ---
const policy = { retries: 2, retryPost: false }
check('first failure: a wait', typeof nextRetryWait(status(503), 'GET', 1, policy, now) === 'number')
check('second failure: a wait', typeof nextRetryWait(status(503), 'GET', 2, policy, now) === 'number')
check('third failure: no more tries (2 retries = 3 tries)', nextRetryWait(status(503), 'GET', 3, policy, now) === null)
check('retries 0: never', nextRetryWait(status(503), 'GET', 1, { retries: 0, retryPost: false }, now) === null)
check('not retryable: never', nextRetryWait(status(404), 'GET', 1, policy, now) === null)

async function main() {
  // --- A wait ends early when the run stops ---
  let stopped = false
  const t0 = Date.now()
  setTimeout(() => { stopped = true }, 120)
  const went = await waitUnlessStopped(5000, () => stopped, undefined, 20)
  check('a stop ends the wait within a poll', !went && Date.now() - t0 < 1000, Date.now() - t0)
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 50)
  check('an aborted signal ends it too', !(await waitUnlessStopped(5000, () => false, ac.signal, 20)))
  const t1 = Date.now()
  check('an uninterrupted wait runs out and says so', await waitUnlessStopped(60, () => false, undefined, 20)
    && Date.now() - t1 >= 55)

  if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1) }
  console.log('\nhttp retry: all passed')
}
main().catch(e => { console.error(e); process.exit(1) })
