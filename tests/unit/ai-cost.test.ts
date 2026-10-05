// Unit test for lib/ai-cost.ts — the pure cost/token math behind estimate_only.
// Pure functions, no DB: run directly under tsx.
// server/src is type:commonjs — under tsx, named ESM imports of a CJS module
// don't resolve; default-import the module object and destructure (same pattern
// as mcp-tool-errors.test.ts).
import aiCost from '../../server/src/lib/ai-cost'
const { parseTokenPrice, estimateTokens, percentile, average, rowCostUsd, roundUsd } = aiCost as typeof import('../../server/src/lib/ai-cost')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

// parseTokenPrice: real decimal strings, free "0", and every junk shape → 0
// (never NaN, which would poison a cost sum).
check('price parses decimal string', parseTokenPrice('0.0000015') === 0.0000015)
check('price "0" is zero', parseTokenPrice('0') === 0)
check('price undefined is zero', parseTokenPrice(undefined) === 0)
check('price junk is zero (not NaN)', parseTokenPrice('free') === 0)
check('price negative is zero', parseTokenPrice('-1') === 0)

// estimateTokens: chars/4, ceil, empty → 0
check('tokens empty is 0', estimateTokens('') === 0)
check('tokens ceil chars/4', estimateTokens('abcde') === 2)

// percentile: nearest-rank; empty → null
check('p75 of 1..100 is 75', percentile(Array.from({ length: 100 }, (_, i) => i + 1), 75) === 75)
check('p75 empty is null', percentile([], 75) === null)
check('p75 single', percentile([42], 75) === 42)
check('p75 unsorted input', percentile([9, 1, 5, 3, 7], 75) === 7)

// average: mean; empty → null
check('average basic', average([2, 4, 6]) === 4)
check('average empty is null', average([]) === null)

// rowCostUsd: input*promptPrice + output*completionPrice
check('rowCost combines both sides', rowCostUsd(100, 200, 0.001, 0.002) === 100 * 0.001 + 200 * 0.002)
check('rowCost zero price is zero', rowCostUsd(100, 200, 0, 0) === 0)

// roundUsd: 2dp for normal, precision-preserving for sub-cent, exact 0
check('roundUsd zero stays 0', roundUsd(0) === 0)
check('roundUsd 2dp', roundUsd(1.2345) === 1.23)
check('roundUsd sub-cent keeps sig digits', roundUsd(0.00012345) === 0.00012)

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall ai-cost checks passed')
