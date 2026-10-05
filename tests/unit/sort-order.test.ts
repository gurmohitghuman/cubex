// The physical sort orders rows with lib/sort-order (a sliced merge sort over
// pre-classified values) instead of Array.sort with compareSortValues. It must
// produce EXACTLY the old order: compareSortValues, ties broken by current row
// order. Pinned on adversarial values (blank and whitespace-only cells, ints,
// decimals, exponents, negatives, number-like text, accents, case, heavy
// duplication), both directions, at sizes that cross the merge-run boundaries.
import assert from 'node:assert/strict'
import sortMod from '../../server/src/lib/sort-order'
import sqlMod from '../../server/src/lib/sql-helpers'
const { sortedOrder } = sortMod as typeof import('../../server/src/lib/sort-order')
const { compareSortValues } = sqlMod as typeof import('../../server/src/lib/sql-helpers')

const pool = ['', ' ', '\t', '0', '-0', '10', '9', '2', '1e3', '1E-2', '-5.5', '3.14', '007', '42 Main St', 'item2',
  'item10', 'Item1', 'apple', 'Apple', 'Äpfel', 'zebra', 'éclair', 'eclair', '  padded ', 'null', '[1]', '{"a":1}',
  'ß', 'SS', '١٢', 'naïve', 'naive', '-', '+1', '.5', '5.', 'Infinity', 'NaN']

let seed = 7
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }

function reference(values: string[], direction: 'asc' | 'desc'): number[] {
  return values.map((_, i) => i).sort((a, b) => compareSortValues(values[a], values[b], direction) || a - b)
}

async function main(): Promise<void> {
  let failures = 0
  for (const n of [0, 1, 2, 37, 16_384, 16_385, 50_000]) {
    const values = Array.from({ length: n }, () => pool[Math.floor(rand() * pool.length)] +
      (rand() < 0.3 ? String(Math.floor(rand() * 1000)) : ''))
    for (const direction of ['asc', 'desc'] as const) {
      try {
        assert.deepEqual(Array.from(await sortedOrder(values, direction)), reference(values, direction))
        console.log(`ok   n=${n} ${direction}`)
      } catch (e) { failures++; console.log(`FAIL n=${n} ${direction}: ${(e as Error).message.slice(0, 200)}`) }
    }
  }
  if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1) }
  console.log('\nAll sort-order assertions passed.')
}
main().catch(e => { console.error(e); process.exit(1) })
