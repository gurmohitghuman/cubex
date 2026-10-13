// OpenRouter's in-flight budget check before an AI run (lib/ai-in-flight.ts):
// each call holds its input plus max_tokens of output at the model's prices,
// and the account may hold only part of its balance, so the balance is a ceiling.
import assert from 'node:assert/strict'
import mod from '../../server/src/lib/ai-in-flight'
// Default import + destructure: Node 22 (CI) can't see named exports of the
// server's CommonJS modules from this ESM test file.
const { inFlightCheck } = mod as typeof import('../../server/src/lib/ai-in-flight')

// $1 per million input tokens, $5 per million output: 2,000 in + 8,000 out = $0.042 a call.
const base = { inputTokens: 2000, maxTokens: 8000, promptPrice: 1e-6, completionPrice: 5e-6 }

const room = inFlightCheck({ ...base, concurrency: 10, balanceUsd: 5 })!
assert.equal(room.reserve_per_call_usd, 0.042)
assert.equal(room.reserve_at_concurrency_usd, 0.42)
assert.equal(room.concurrency_ceiling, 119, 'the whole balance: an upper bound')
assert.equal(room.warning, undefined, 'under the whole balance: no warning, only the note')
assert.match(room.note, /part of its balance/)

const over = inFlightCheck({ ...base, concurrency: 50, balanceUsd: 1 })!
assert.equal(over.reserve_at_concurrency_usd, 2.1)
assert.equal(over.concurrency_ceiling, 23)
assert.match(over.warning ?? '', /\$2\.10 at once, more than the whole \$1\.00 OpenRouter balance/)
assert.match(over.warning ?? '', /well under 23/)

const broke = inFlightCheck({ ...base, concurrency: 5, balanceUsd: 0.01 })!
assert.equal(broke.concurrency_ceiling, 0)
assert.match(broke.warning ?? '', /Even one call/)

const unknown = inFlightCheck({ ...base, concurrency: 50, balanceUsd: null })!
assert.equal(unknown.account_balance_usd, null)
assert.equal(unknown.concurrency_ceiling, null)
assert.equal(unknown.warning, undefined, 'no balance from OpenRouter: no warning')
assert.match(unknown.note, /management key/)

const tiny = inFlightCheck({ ...base, promptPrice: 1e-9, completionPrice: 1e-9, concurrency: 1, balanceUsd: null })!
assert.match(tiny.note, /up to \$0\.00001 /, 'sub-cent holds are not printed as $0.00')
assert.equal(inFlightCheck({ ...base, promptPrice: 0, completionPrice: 0, concurrency: 50, balanceUsd: 1 }), null,
  'a free model holds nothing')
console.log('ai-in-flight: ok')
