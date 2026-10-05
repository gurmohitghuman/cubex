// Regression test for the QA-found bug: a MALFORMED HTTP-enrichment JSONPath
// (e.g. "$.nope[") used to slip through validateHttpJsonPath because jsonpath-plus
// is not a syntax validator — it silently returns [] (blank cell) or, worse, a
// WRONG value for "$.a[b". validateHttpJsonPath now uses a POSITIVE allowlist that
// is a superset of the strict webhook grammar (adds *, .., array indexes — the
// HTTP modal has always documented "$.data[0].value" / "$.results[*].title") but
// rejects genuinely malformed shells up front, so /run and /preview return a clean
// config error instead of silently producing blank/incorrect cells.
//
// Pure function — but the import graph opens a DB, so a throwaway DB_PATH is required.

import assert from 'node:assert/strict'
import jsonpathExtract from '../../server/src/lib/jsonpath-extract'

const { validateHttpJsonPath } = jsonpathExtract

if (!process.env.DB_PATH) {
  console.error('Refusing to run without a throwaway DB_PATH set.')
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

// Must ACCEPT — everything the click-mapper emits AND everything the modal
// documents/allows (bare $, dotted fields, bracket-quoted keys, array indexes,
// wildcards, recursive descent). Rejecting any of these would break a saved template.
const ACCEPT = [
  '$', '$.name', '$.data.name', '$.address.city',
  '$.data[0].value', '$.results[*].title',       // modal examples
  '$["first name"]', '$.data["x-id"]',            // bracket-quoted keys the builder emits
  '$..author', '$..*', '$.*',                     // wildcard + recursive descent (contract)
  '$.a.b.c[3]["k"]', '$[0]', '$[*]',
]
for (const p of ACCEPT) {
  check(`accept ${JSON.stringify(p)}`, validateHttpJsonPath(p).ok === true)
}

// Must REJECT — malformed shells (the actual bug), no leading $, and constructs
// that were never supported (filters, scripts, unions, negative index, slices).
const REJECT = [
  '$.nope[',        // unbalanced bracket → jsonpath-plus returned [] (silent blank)
  '$.a[b',          // unbalanced → jsonpath-plus returned a WRONG value [1]
  '$[', '$.', '$.a..', '$["unclosed', "$.a['x",
  'garbage', '.name', 'name', '',                 // no leading $
  '$.items[?(@.x)]', '$.a[(1)]',                   // filter / script (eval constructs)
  '$[0,1]', '$[-1]', '$[0:5]',                     // union / negative / slice (unsupported)
]
for (const p of REJECT) {
  const r = validateHttpJsonPath(p)
  check(`reject ${JSON.stringify(p)}`, r.ok === false && typeof r.reason === 'string')
}

// Over-length is rejected with the length message, not the grammar message.
const long = '$' + '.a'.repeat(5000)
const longRes = validateHttpJsonPath(long)
check('over-length path rejected', longRes.ok === false)
assert.ok((longRes.reason || '').includes('limit'), 'length rejection cites the limit')

if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1) }
console.log('\nAll http-jsonpath-validate assertions passed.')
