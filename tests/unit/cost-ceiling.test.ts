// The cost ceiling's one rule (lib/cost-ceiling.ts) and what run_ai_column
// reads from its estimate (services/run-start-ceiling.ts): under, equal and
// over the ceiling, something with no price with and without allow_unpriced,
// no ceiling at all; the arguments refused as sent; the estimate's view;
// spend_limit_usd and max_cost_usd giving the run's limit (the lower one); and
// the idempotency hash, unchanged when they are unset (keys from before still
// replay) and different when they are set.
import assert from 'node:assert/strict'
import ceilingMod from '../../server/src/lib/cost-ceiling'
import startMod from '../../server/src/services/run-start-ceiling'
import ledgerMod from '../../server/src/lib/run-idempotency'
const { ceilingArgsOf, ceilingProblem, ceilingView, money, usdLimitOf, CAMEL } =
  ceilingMod as typeof import('../../server/src/lib/cost-ceiling')
const { aiCeilingFigures, aiRunLimitsOf, aiRunRequestHash } =
  startMod as typeof import('../../server/src/services/run-start-ceiling')
const { runRequestHash } = ledgerMod as typeof import('../../server/src/lib/run-idempotency')

const ok = (label: string) => console.log('ok  ', label)
const c = (maxCostUsd: number | null, allowUnpriced = false) => ({ maxCostUsd, allowUnpriced })

// --- The rule -------------------------------------------------------------------
assert.equal(ceilingProblem({ highUsd: 0.5, unpriced: [] }, c(1)), null)
assert.equal(ceilingProblem({ highUsd: 1, unpriced: [] }, c(1)), null)
// Alike to the micro-dollar is alike (float noise in a sum isn't over).
assert.equal(ceilingProblem({ highUsd: 0.1 + 0.2, unpriced: [] }, c(0.3)), null)
ok('under or equal to the ceiling: no problem')

const over = ceilingProblem({ highUsd: 1.25, unpriced: [] }, c(1))
assert.match(over ?? '', /could cost up to \$1\.25, more than the \$1\.00 ceiling \(max_cost_usd\)/)
assert.match(ceilingProblem({ highUsd: 0.00002, unpriced: [] }, c(0.000001)) ?? '', /\$0\.00002.*\$0\.000001/)
ok('over the ceiling, also below a cent: refused, both amounts said')

const unpriced = ceilingProblem({ highUsd: 0.1, unpriced: ['Fit (Output)', 'Email'] }, c(1))
assert.match(unpriced ?? '', /No price is known for "Fit \(Output\)" and "Email".*allow_unpriced: true/)
assert.equal(ceilingProblem({ highUsd: 0.1, unpriced: ['Fit (Output)'] }, c(1, true)), null)
const both = ceilingProblem({ highUsd: 2, unpriced: ['x'] }, c(1)) ?? ''
assert.ok(both.includes('more than the $1.00 ceiling') && both.includes('No price is known for "x"'))
ok('something with no price: refused unless allow_unpriced, and both reasons said together')

assert.equal(ceilingProblem({ highUsd: 1e9, unpriced: ['x'] }, c(null)), null)
assert.equal(ceilingProblem({ highUsd: 1e9, unpriced: ['x'] }, c(null, true)), null)
assert.deepEqual(ceilingView({ highUsd: 1e9, unpriced: ['x'] }, c(null)), {})
ok('no ceiling: nothing is checked, allow_unpriced does nothing, the estimate adds nothing')

assert.deepEqual(ceilingView({ highUsd: 2, unpriced: [] }, c(1)),
  { max_cost_usd: 1, over_ceiling: true, ceiling_problem: ceilingProblem({ highUsd: 2, unpriced: [] }, c(1)) })
assert.deepEqual(ceilingView({ highUsd: 0.5, unpriced: [] }, c(1)),
  { max_cost_usd: 1, over_ceiling: false, ceiling_problem: null })
assert.match(ceilingProblem({ highUsd: 2, unpriced: ['x'] }, c(1), CAMEL) ?? '', /\(maxCostUsd\).*allowUnpriced: true/)
ok('an estimate says over_ceiling and ceiling_problem; the app gets its own field names')

// --- The arguments ----------------------------------------------------------------
for (const bad of [0, -1, 'ten', Number.NaN, 2_000_000, true]) {
  assert.ok('error' in ceilingArgsOf(bad, undefined), `max_cost_usd ${String(bad)}`)
  assert.ok('error' in usdLimitOf(bad, 'spend_limit_usd'), `spend_limit_usd ${String(bad)}`)
}
assert.ok('error' in ceilingArgsOf(1, 'yes'))
assert.deepEqual(ceilingArgsOf(undefined, undefined), { maxCostUsd: null, allowUnpriced: false })
assert.deepEqual(ceilingArgsOf(0.5, 'true'), { maxCostUsd: 0.5, allowUnpriced: true })
assert.match((ceilingArgsOf(0, undefined, CAMEL) as { error: string }).error, /^maxCostUsd must be/)
ok('max_cost_usd and spend_limit_usd: more than $0 and at most $1,000,000; allow_unpriced true or false')

assert.equal(money(0), '$0.00')
assert.equal(money(12.5), '$12.50')
assert.equal(money(0.00042), '$0.00042')
assert.equal(money(0.000001), '$0.000001')
assert.equal(money(0.0000001), '$0.0000001')
ok('money never shows a real amount as $0.00')

// --- run_ai_column's limits ---------------------------------------------------------
type Limits = Exclude<ReturnType<typeof aiRunLimitsOf>, { error: string }>
const limits = (a: Record<string, unknown>) => aiRunLimitsOf(a) as Limits
assert.equal(limits({}).spendLimitUsd, null)
assert.equal(limits({}).any, false)
assert.equal(limits({ max_cost_usd: 2 }).spendLimitUsd, 2)
assert.equal(limits({ spend_limit_usd: 3 }).spendLimitUsd, 3)
assert.equal(limits({ spend_limit_usd: 3, max_cost_usd: 2 }).spendLimitUsd, 2)
assert.equal(limits({ spend_limit_usd: 1, max_cost_usd: 2 }).spendLimitUsd, 1)
assert.ok('error' in aiRunLimitsOf({ spend_limit_usd: 0 }))
ok('the run\'s hard limit is max_cost_usd or spend_limit_usd, the lower of the two')

const est = (over: Record<string, unknown>) => ({
  rows_to_process: 3, model: 'm/x', pricing_available: true, estimated_cost_usd: { low: 0.1, high: 0.2 },
  per_row_usd: null, web_fees_usd: null, web_search: null, basis: 'history', note: '',
  assumptions: { avg_input_tokens: 1, input_tokens: { low: 1, high: 1 }, output_tokens: { low: 1, high: 1 },
    sampled_rows: 1, history_rows: 0 }, ...over,
}) as never
assert.deepEqual(aiCeilingFigures(est({})), { highUsd: 0.2, unpriced: [] })
assert.deepEqual(aiCeilingFigures(est({ estimated_cost_usd: null, pricing_available: false })),
  { highUsd: 0, unpriced: ['m/x'] })
assert.deepEqual(aiCeilingFigures(est({ web_search: { price_per_search_usd: null } })),
  { highUsd: 0.2, unpriced: ['web search'] })
assert.deepEqual(aiCeilingFigures(est({ web_search: { price_per_search_usd: null }, basis: 'measured' })),
  { highUsd: 0.2, unpriced: [] })
ok('an AI estimate: a model with no price, or search fees neither priced nor measured, is unpriced')

// --- The idempotency hash -----------------------------------------------------------
const a = { sheet_id: 's1', column_name: 'Fit', prompt: 'Rate /name', model: 'm/x', webhook_id: 'w1' }
const parsed = { useOpenRouterWebSearch: false, useWebFetch: false, search: null, runIf: 'x is "y"' }
// What run-start-token.ts hashed before these fields existed.
const before = runRequestHash('ai_run', {
  sheet_id: 's1', column_name: a.column_name, prompt: a.prompt, system_prompt: undefined, model: a.model,
  concurrency: undefined, output_columns: undefined, target_row_ids: undefined, temperature: undefined,
  max_chars: undefined, web_search: false, web_fetch: false, run_if: parsed.runIf, webhook_id: 'w1',
})
const hash = (extra: Record<string, unknown>) => aiRunRequestHash('s1', { ...a, ...extra }, parsed, limits(extra))
assert.equal(hash({}), before)
assert.equal(hash({ allow_unpriced: false }), before)
const capped = hash({ max_cost_usd: 1 })
assert.notEqual(capped, before)
assert.notEqual(hash({ max_cost_usd: 2 }), capped)
assert.notEqual(hash({ max_cost_usd: 1, allow_unpriced: true }), capped)
assert.equal(hash({ max_cost_usd: 1, allow_unpriced: 'false' }), capped)
assert.notEqual(hash({ spend_limit_usd: 1 }), before)
assert.notEqual(hash({ spend_limit_usd: 1 }), capped)
ok('the ledger hash: unchanged without them, and max_cost_usd, allow_unpriced, spend_limit_usd count when set')
