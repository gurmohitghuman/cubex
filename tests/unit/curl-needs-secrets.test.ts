// Whether a cURL command needs the 'secrets' scope is read from the command alone (services/curl-token.ts
// curlNeedsSecrets), with the saved key names read once and matched in one pass: a command of 9,000 headers, for
// a user with 300 saved keys, is answered within CURL_SECRETS_SCAN_MAX_MS (best of a few runs), whether it names
// no saved key (false) or names one in its last header, so every part is read (true).
import assert from 'node:assert/strict'
import { undoKit } from './run-undo-kit'
import curlMod from '../../server/src/services/curl-token'
import keysMod from '../../server/src/services/saved-keys'
import constMod from '../../server/src/lib/constants-curl'
const { curlNeedsSecrets } = curlMod as typeof import('../../server/src/services/curl-token')
const { createSavedKey } = keysMod as typeof import('../../server/src/services/saved-keys')
const { CURL_MAX_CHARS, CURL_SECRETS_SCAN_MAX_MS } = constMod as typeof import('../../server/src/lib/constants-curl')
const { uid, ok, done } = undoKit('curl-needs-secrets')

const HEADERS = 9000, KEYS = 300, RUNS = 3
for (let i = 0; i < KEYS; i++) {
  const made = createSavedKey(uid, { name: `scan_key_${i}`, key_type: 'bearer', key_value: `scan-value-${i}-0123456789`,
    description: null })
  assert.ok('ok' in made, JSON.stringify(made))
}
let headers = ''
for (let i = 0; i < HEADERS; i++) headers += ` -H h${i}:v`
const keyless = `curl 'https://api.example.com/x'${headers}`
const naming = `${keyless} -H 'Last: {{scan_key_${KEYS - 1}}}'`
assert.ok(naming.length <= CURL_MAX_CHARS, `${naming.length} characters`)

// The answer, and the fastest of RUNS runs.
function timed(curl: string): { answer: boolean; ms: number } {
  let answer = false, ms = Infinity
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now()
    answer = curlNeedsSecrets(uid, curl)
    ms = Math.min(ms, performance.now() - start)
  }
  return { answer, ms }
}

await ok(`${HEADERS} headers naming no saved key, ${KEYS} saved keys: no 'secrets' needed, within `
  + `${CURL_SECRETS_SCAN_MAX_MS} ms`, () => {
  const { answer, ms } = timed(keyless)
  assert.equal(answer, false)
  assert.ok(ms < CURL_SECRETS_SCAN_MAX_MS, `took ${ms.toFixed(0)} ms`)
})

await ok(`${HEADERS} headers, the last naming a saved key, ${KEYS} saved keys: 'secrets' needed, within `
  + `${CURL_SECRETS_SCAN_MAX_MS} ms`, () => {
  const { answer, ms } = timed(naming)
  assert.equal(answer, true)
  assert.ok(ms < CURL_SECRETS_SCAN_MAX_MS, `took ${ms.toFixed(0)} ms`)
})

done()
