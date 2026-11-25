// The order a column run takes its columns in (server/src/lib/column-runs/order.ts, pure):
//   - columns that don't read each other share the first layer;
//   - a column reading another chosen column's output waits for it (the next layer), down a chain;
//   - read through a formula, clean or lookup column, it waits too, and names that column (between);
//   - a run column that isn't chosen is no reason to wait;
//   - two columns that read each other are refused with both names;
//   - changes: every column the chosen runs write, and the derived columns worked out from them only.
import assert from 'node:assert/strict'
import orderMod from '../../server/src/lib/column-runs/order'
const { orderColumns } = orderMod as typeof import('../../server/src/lib/column-runs/order')

const ok = (label: string) => console.log('ok  ', label)
const col = (main: string, reads: string[], writes: string[] = [main]) => ({ main, reads, writes })
const order = (...args: Parameters<typeof orderColumns>) => {
  const out = orderColumns(...args)
  if ('problem' in out) throw new Error(out.problem)
  return out.ok
}
const none = new Map<string, string[]>()

const flat = order([col('A (Output)', ['Name']), col('B', ['Website'])], none)
assert.deepEqual(flat.layers, [0, 0])
assert.deepEqual(flat.waitsFor, [[], []])
ok('columns that read nothing the others fill share the first layer')

const chain = order([
  col('C', ['B score']), col('B', ['A (Output)'], ['B', 'B score']), col('A (Output)', ['Name']),
], none)
assert.deepEqual(chain.layers, [2, 1, 0])
assert.deepEqual(chain.waitsFor, [[1], [2], []])
ok('a column reading another chosen column waits for it, down a chain (any column a run writes counts)')

const derived = new Map([['Len', ['Clean']], ['Clean', ['A (Output)']], ['Other', ['Name']]])
const through = order([col('A (Output)', ['Name']), col('Ping', ['Len', 'Other'])], derived)
assert.deepEqual(through.layers, [0, 1])
assert.deepEqual(new Set(through.between[1]), new Set(['Len', 'Clean']))
assert.deepEqual(through.between[0], [])
ok('read through formula or clean columns it waits too, naming the ones in between (not the others it reads)')

const unchosen = order([col('Ping', ['Score (Output)'])], none)
assert.deepEqual(unchosen.layers, [0])
ok('a run column that is not chosen is no reason to wait')

const loop = orderColumns([col('A', ['B']), col('B', ['Len'])], new Map([['Len', ['A']]]))
assert.ok('problem' in loop)
assert.match(loop.problem, /"A" and "B" each read what the other fills/)
ok('two columns that read each other (here through a formula) are refused, naming both')

assert.deepEqual(new Set(through.changes), new Set(['A (Output)', 'Ping', 'Clean', 'Len']))
ok('changes: what the chosen runs write and the derived columns worked out from them, not the rest')

console.log('All column-run-order assertions passed.')
