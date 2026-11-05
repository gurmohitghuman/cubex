// An AI run's spend limit, worked out (lib/ai-spend-limit.ts): a row's most
// (its text at one token a byte, all the output it may write, the model's
// request fee, web fees and found text when it searches), the start, wait or
// pause decision with rows in flight and calls cut off (held as spent), and a
// simulated run at several concurrencies whose rows each cost up to their
// most: it never spends past its limit, it stops only when what is left can't
// cover the next row, it never waits with nothing out (some calls cut off),
// and a raised limit lets it finish.
import assert from 'node:assert/strict'
import limitMod from '../../server/src/lib/ai-spend-limit'
import constMod from '../../server/src/lib/constants'
const {
  admitRow, priceModelId, rowFixedFor, rowMaxMicro, rowPricesOf, spendLimitMessage, webPart,
} = limitMod as typeof import('../../server/src/lib/ai-spend-limit')
const { AI_HOLD_MESSAGE_TOKENS, AI_HOLD_WEB_TOOLS_TOKENS, WEB_SEARCH_TOKENS_PER_SEARCH } =
  constMod as typeof import('../../server/src/lib/constants')

const ok = (label: string) => console.log('ok  ', label)

// --- Prices and a row's most ---------------------------------------------------------
const prices = rowPricesOf({
  prompt: '0.000001', completion: '0.000002', internal_reasoning: '0.000003', request: '0.005',
})
assert.deepEqual(prices, { prompt: 0.000001, completion: 0.000003, request: 0.005 })
assert.deepEqual(rowPricesOf({ prompt: '0', completion: '0' }), { prompt: 0, completion: 0, request: 0 })
// openrouter/auto lists "-1": its price varies, so there is no listed price (never free).
assert.equal(rowPricesOf({ prompt: '-1', completion: '-1' }), null)
assert.equal(rowPricesOf({ prompt: '0.000001', completion: '-0.5' }), null)
assert.equal(rowPricesOf({ prompt: '0.000001', completion: '0.000001', request: '-1' }), null)
assert.equal(rowPricesOf({ prompt: 'x', completion: '0.000001' }), null)
ok('prices: the dearer of output and reasoning per output token, the request fee; a negative or junk one: none')

assert.equal(priceModelId('openai/gpt-4o-mini:nitro'), 'openai/gpt-4o-mini')
assert.equal(priceModelId('openai/gpt-4o-mini:floor:exacto'), 'openai/gpt-4o-mini')
assert.equal(priceModelId('openai/gpt-4o-mini@preset/fast'), 'openai/gpt-4o-mini')
assert.equal(priceModelId('openai/gpt-4o-mini:online'), 'openai/gpt-4o-mini:online')
assert.equal(priceModelId('m/free:free'), 'm/free:free')
ok('a routing variant is priced as its model; :online (web fees) and :free are not')

const fixed = { maxTokens: 8000, fixedBytes: 100, messages: 2, webTokens: 0, webFeesUsd: 0 }
const p = { prompt: 0.000001, completion: 0.000002, request: 0 }
// (50 + 100 bytes + 2 messages' framing) tokens at $1/M, plus 8000 output tokens at $2/M.
const input = 50 + 100 + 2 * AI_HOLD_MESSAGE_TOKENS
assert.equal(rowMaxMicro(p, fixed, 50), input + 16_000)
assert.equal(rowMaxMicro({ ...p, request: 0.005 }, fixed, 50), input + 16_000 + 5_000)
assert.equal(rowMaxMicro({ prompt: 0, completion: 0, request: 0 }, fixed, 50), 0)
const bare = { ...fixed, fixedBytes: 0, messages: 0 }
assert.equal(rowMaxMicro({ prompt: 0.0000001, completion: 0, request: 0 }, bare, 5), 1)
ok('a row\'s most: every byte a token, the framing, all the output it may write, the request fee; rounded up')

const plain = webPart({ model: 'm/x', search: false, fetch: false, used: null, mode: null, maxPerRow: null })
assert.deepEqual(plain, { tokens: 0, feesUsd: 0 })
const capped = webPart({ model: 'm/x', search: true, fetch: false, used: 'exa', mode: null, maxPerRow: 4 })
assert.equal(capped.tokens, 4 * WEB_SEARCH_TOKENS_PER_SEARCH.high + AI_HOLD_WEB_TOOLS_TOKENS)
assert.ok(Math.abs(capped.feesUsd - 4 * 0.007) < 1e-12)
const native = webPart({ model: 'openai/gpt-5', search: true, fetch: true, used: 'native', mode: null, maxPerRow: 2 })
assert.ok(native.feesUsd > 2 * 0.01 && native.tokens > 2 * WEB_SEARCH_TOKENS_PER_SEARCH.high)
ok('web search: its most searches at the engine\'s price and the text they bring; fetch adds pages')

const runLike = { model: 'm/x', systemPrompt: 'Be brief', outputColumns: null, maxChars: null,
  web: { search: false, fetch: false, used: null, mode: null, maxPerRow: null } }
assert.deepEqual(rowFixedFor(runLike), { maxTokens: 8000, fixedBytes: 8, messages: 2, webTokens: 0, webFeesUsd: 0 })
assert.equal(rowFixedFor({ ...runLike, maxChars: 12_000 }).maxTokens, 12_000)
const multi = rowFixedFor({ ...runLike, outputColumns: [{ columnName: 'A', type: 'string', description: 'a' }] })
assert.ok(multi.fixedBytes > 8 && multi.messages === 2, 'a structured run counts its JSON instruction')
const web = rowFixedFor({ ...runLike, web: { ...runLike.web, fetch: true } })
assert.ok(web.fixedBytes > 100 && web.webTokens > 0 && web.webFeesUsd > 0, 'web tools: their system message and fees')
ok('what a row sends besides its prompt: the max_tokens it sends, its system prompt or instruction, web tools')

// --- Start, wait or pause ---------------------------------------------------------------
const d = (limit: number, spent: number, held: number, row: number, stuck = 0) =>
  admitRow({ limitMicro: limit, spentMicro: spent, heldMicro: held, stuckMicro: stuck, rowMicro: row })
assert.equal(d(100, 0, 0, 100), 'start')
assert.equal(d(100, 50, 0, 50), 'start')
assert.equal(d(100, 50, 1, 50), 'wait', 'a row out holds the room: wait for it')
assert.equal(d(100, 51, 0, 50), 'pause', 'spending alone leaves no room')
assert.equal(d(100, 51, 40, 50), 'pause', 'no row out can give room back that was spent')
assert.equal(d(100, 99, 0, 0), 'start', 'a free row still starts below the limit')
assert.equal(d(100, 100, 0, 0), 'pause', 'at the limit, even a free row (an unpriced run) stops')
ok('start while spent + held + this row fit; wait while only rows out are in the way; else pause')

// A call cut off before it answered may be billed: its most counts as spent, never as room that comes back.
assert.equal(d(100, 0, 0, 40, 40), 'start')
assert.equal(d(100, 0, 0, 40, 61), 'pause', 'spent + cut off + this row: no room, and nothing out to wait for')
assert.equal(d(100, 0, 30, 40, 40), 'wait', 'rows out can still give room back')
for (let i = 0; i < 2000; i++) {
  const r = (n: number) => Math.floor(((i * 7919 + n * 104729) % 1000))
  assert.notEqual(d(1000, r(1), 0, r(2), r(3)), 'wait', 'with nothing out it never waits')
}
ok('calls cut off count with what was spent: with nothing out it pauses, never waits')

assert.match(spendLimitMessage(1, 0.995, 0.01),
  new RegExp('^The run reached its \\$1\\.00 spend limit \\(\\$0\\.99 spent\\)\\. The next row could cost up to '
    + '\\$0\\.01, more than is left\\. Resume it with a higher limit to go on\\.$'))
assert.match(spendLimitMessage(1, 1.02, null), /No price is listed for its model, so it stopped on what was billed/)
assert.match(spendLimitMessage(5, 4.8, 0.12, 0.12), new RegExp(
  '^The run reached its \\$5\\.00 spend limit \\(\\$4\\.80 spent\\)\\. Calls cut off before their answer came '
  + 'back may still be billed \\(up to \\$0\\.12\\), so that counts as spent\\. The next row could cost up to '
  + '\\$0\\.12, more than is left\\.'))
ok('the pause says the limit, what was spent and why it stopped, in enrichment runs\' words')

// --- A simulated run -----------------------------------------------------------------------
// Rows of `most` micro each (their most), each really costing a random part of
// it, `concurrency` at once, finishing in random order. Returns what was spent,
// the rows done and whether it paused with rows left.
// cutOff: the share of calls cut off before they answered (no cost seen; their
// most stays held as spent, and each really costs up to it).
function simulate(rows: number[], limit: number, concurrency: number, seed: number, cutOff = 0) {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
  let spent = 0, held = 0, stuck = 0, billed = 0, next = 0, done = 0, paused = false, most = 0
  const out: Array<{ hold: number; cost: number }> = []
  const settle = () => {
    if (!out.length) throw new Error('waited with no row out: the run would wait for good')
    const [r] = out.splice(Math.floor(rnd() * out.length), 1)
    held -= r.hold
    billed += r.cost
    if (rnd() < cutOff) stuck += r.hold; else spent += r.cost
    done++
  }
  while (next < rows.length) {
    if (out.length >= concurrency) { settle(); continue }
    const row = rows[next]
    const decision = admitRow({
      limitMicro: limit, spentMicro: spent, heldMicro: held, stuckMicro: stuck, rowMicro: row,
    })
    if (decision === 'wait') { settle(); continue }
    if (decision === 'pause') { paused = true; break }
    held += row
    most = Math.max(most, spent + stuck + held)
    out.push({ hold: row, cost: Math.floor(row * (0.2 + 0.8 * rnd())) })
    next++
  }
  while (out.length) settle()
  return { spent, billed, done, paused, next, most }
}
const rows = Array.from({ length: 200 }, (_, i) => 1_000 + ((i * 7919) % 5_000))
for (const concurrency of [1, 3, 20, 100]) {
  for (const seed of [1, 7, 42]) {
    const limit = 150_000
    const r = simulate(rows, limit, concurrency, seed)
    assert.ok(r.spent <= limit, `spent ${r.spent} past ${limit} at ${concurrency}`)
    assert.ok(r.most <= limit, `held ${r.most} past ${limit} at ${concurrency}`)
    assert.equal(r.paused, true)
    assert.ok(limit - r.spent < rows[r.next], 'it paused only when the next row could not fit')
    // A raised limit picks up where it paused and finishes.
    const rest = simulate(rows.slice(r.next), 10_000_000, concurrency, seed)
    assert.equal(rest.paused, false)
    assert.equal(r.done + rest.done, rows.length)
  }
}
ok('a simulated run at 1, 3, 20 and 100 rows at once never spends or holds past its limit, then finishes when raised')

for (const concurrency of [1, 3, 20]) {
  for (const seed of [3, 11]) {
    const limit = 150_000
    const r = simulate(rows, limit, concurrency, seed, 0.3)
    assert.equal(r.paused, true)
    assert.ok(r.billed <= limit, `billed ${r.billed} past ${limit}: cut-off calls billed at their most still fit`)
  }
}
ok('with calls cut off it pauses instead of waiting with nothing out, and even billed in full they stay within')
