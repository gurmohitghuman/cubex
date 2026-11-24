// Splits the unit test files between CI runners. UNIT_SHARD=k/n runs the k-th of n shares of the sorted list: file i
// (from 0) goes to share i % n + 1. So every file runs on exactly one runner, still alone there, and files whose
// names sit together (a slow family such as bulk-wal-*) spread over the shares. Plain Node, as unit-tests.mjs.

// The share UNIT_SHARD asks for: null when it's unset or empty (every file), or { k, n }. Anything else throws.
export function parseShard(text) {
  if (text === undefined || text === '') return null;
  const m = /^(\d{1,3})\/(\d{1,3})$/.exec(text);
  const k = m ? Number(m[1]) : 0;
  const n = m ? Number(m[2]) : 0;
  if (!m || n < 1 || k < 1 || k > n) {
    throw new Error(`UNIT_SHARD must be k/n with k from 1 to n (2/3: the second of 3 shares), not '${text}'`);
  }
  return { k, n };
}

// The files of share k of n, in their order; every file when there is no share.
export const filesOfShard = (files, shard) => (shard ? files.filter((_, i) => i % shard.n === shard.k - 1) : files);
