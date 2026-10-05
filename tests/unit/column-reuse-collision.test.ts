// Regression test for P2-3 (+ the fable-review fix): columnReuseCollision — the
// guard AI run start/rerun use before creating "<name> (Output)"/"(Data)".
//
// It must reject a case/token collision with a DIFFERENT existing column, but
// ALLOW self-reuse (the run writing to its own existing column) — including on a
// sheet that ALREADY holds a case/token variant of that column (the exact state
// the pre-fix bug created). The naive "kind !== 'exact'" guard failed the last
// case because findColumnNameCollision returns the FIRST match in list order, so
// a variant preceding the exact column would 409 a legitimate refresh.
//
// Pure function — runs under tsx, needs a throwaway DB_PATH (column-names.ts
// pulls in the prompt/sql helpers whose import graph opens a DB).

import assert from 'node:assert/strict'
import columnNames from '../../server/src/lib/column-names'

const { columnReuseCollision } = columnNames

if (!process.env.DB_PATH) {
  console.error('Refusing to run without a throwaway DB_PATH set.')
  process.exit(1)
}

let failures = 0
function check(label: string, actual: string | null, expect: 'allow' | 'reject') {
  const ok = expect === 'allow' ? actual === null : typeof actual === 'string' && actual.length > 0
  if (ok) { console.log('ok  ', label) }
  else { failures++; console.log('FAIL', label, `\n  got: ${JSON.stringify(actual)} (wanted ${expect})`) }
}

// --- Self-reuse: candidate exists exactly → ALLOW (writes to its own column) ---
check('exact self-reuse on a clean sheet → allow',
  columnReuseCollision('Company (Output)', ['val', 'Company (Output)']), 'allow')

// THE fable EDGE: a case/token variant PRECEDES the run's own exact column in
// the list. Must still ALLOW — the run refreshes its own column, creates nothing.
check('self-reuse when a token variant precedes the exact column → allow',
  columnReuseCollision('Company (Output)', ['Company Output', 'Company (Output)']), 'allow')
check('self-reuse when a case variant precedes the exact column → allow',
  columnReuseCollision('enriched (output)', ['ENRICHED (OUTPUT)', 'enriched (output)']), 'allow')

// --- Genuine collisions with a DIFFERENT column (candidate does NOT exist) → REJECT ---
check('case collision with a different column → reject',
  columnReuseCollision('AI (Output)', ['ai (output)']), 'reject')
check('token collision with a different column → reject',
  columnReuseCollision('AI (Output)', ['ai output!']), 'reject')

// --- No collision at all → ALLOW ---
check('brand-new distinct column → allow',
  columnReuseCollision('Fresh (Output)', ['val', 'Company (Output)']), 'allow')

if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1) }
console.log('\nAll column-reuse-collision assertions passed.')
