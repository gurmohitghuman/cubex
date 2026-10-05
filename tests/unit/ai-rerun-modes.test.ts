// Unit test for services/ai-rerun-modes.ts — the rerun target predicate.
// The bug this guards: the old implicit default treated empty AND errored AND
// unfinished as one bucket, so "retry the 10 failures" re-ran (and re-billed)
// every blank row on the sheet. Each mode must select exactly its own class.
// server/src is type:commonjs → default-import + destructure under tsx.
import rerunModes from '../../server/src/services/ai-rerun-modes'
const { matchesRerunMode, AI_RERUN_MODES, DEFAULT_AI_RERUN_MODE } =
  rerunModes as typeof import('../../server/src/services/ai-rerun-modes')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

// Representative cell values, one per real-world class.
const BLANK = ''
const WHITESPACE = '   '
const NULLCELL = null            // column never populated on this row
const ERRORED = '❌ Error: Connection error. (EPIPE)'
const PROCESSING = '⏳ Processing...'
const GOOD = 'Acme Corp is a B2B SaaS company.'
const GOOD_WITH_X = 'The answer is no ❌ per their policy'  // ❌ mid-string, NOT a failure

// --- errored: ONLY ❌-prefixed cells -----------------------------------------
check('errored picks ❌ cell', matchesRerunMode(ERRORED, 'errored') === true)
check('errored skips blank', matchesRerunMode(BLANK, 'errored') === false)
check('errored skips null', matchesRerunMode(NULLCELL, 'errored') === false)
check('errored skips processing', matchesRerunMode(PROCESSING, 'errored') === false)
check('errored skips good value', matchesRerunMode(GOOD, 'errored') === false)
// The sentinel is a PREFIX. A ❌ inside legitimate model output is not a failure —
// treating it as one would silently re-bill good rows.
check('errored skips mid-string ❌', matchesRerunMode(GOOD_WITH_X, 'errored') === false)

// --- empty: ONLY blank cells -------------------------------------------------
check('empty picks blank', matchesRerunMode(BLANK, 'empty') === true)
check('empty picks whitespace-only', matchesRerunMode(WHITESPACE, 'empty') === true)
check('empty picks null cell', matchesRerunMode(NULLCELL, 'empty') === true)
check('empty skips errored', matchesRerunMode(ERRORED, 'empty') === false)
check('empty skips processing', matchesRerunMode(PROCESSING, 'empty') === false)
check('empty skips good value', matchesRerunMode(GOOD, 'empty') === false)

// --- missing: the historical union (empty | errored | unfinished) ------------
check('missing picks blank', matchesRerunMode(BLANK, 'missing') === true)
check('missing picks null', matchesRerunMode(NULLCELL, 'missing') === true)
check('missing picks errored', matchesRerunMode(ERRORED, 'missing') === true)
check('missing picks processing', matchesRerunMode(PROCESSING, 'missing') === true)
check('missing skips good value', matchesRerunMode(GOOD, 'missing') === false)

// --- all: every row, no exceptions -------------------------------------------
check('all picks good value', matchesRerunMode(GOOD, 'all') === true)
check('all picks blank', matchesRerunMode(BLANK, 'all') === true)
check('all picks null', matchesRerunMode(NULLCELL, 'all') === true)
check('all picks errored', matchesRerunMode(ERRORED, 'all') === true)

// --- the incident, as a regression test --------------------------------------
// A sheet of 9,675 rows where 10 failed and the rest are legitimately populated.
// 'errored' must select 10, not 9,675.
const sheet = [
  ...Array.from({ length: 9665 }, (_, i) => `result for row ${i}`),
  ...Array.from({ length: 10 }, () => ERRORED),
]
check('errored selects only the 10 failures',
  sheet.filter(v => matchesRerunMode(v, 'errored')).length === 10)
check('all would select every row (the expensive choice, made explicit)',
  sheet.filter(v => matchesRerunMode(v, 'all')).length === 9675)
// And on a FRESH column (every cell blank), 'missing' really is the whole sheet —
// which is exactly why it must not be the silent default on a programmatic surface.
const freshColumn = Array.from({ length: 9675 }, () => BLANK)
check('missing on a fresh column = the whole sheet',
  freshColumn.filter(v => matchesRerunMode(v, 'missing')).length === 9675)

// --- falsy non-string cells (parity guard) -----------------------------------
// json_extract returns a REAL JS number for a numeric cell, so an AI score of 0
// arrives here as the number 0, not '0'. The historical predicate used `|| ''`,
// which coerces falsy values to '' → the row counts as EMPTY. Pinning that:
// switching to `?? ''` during a refactor silently changes which rows a 'missing'
// rerun targets (a 0-score row would stop being re-run). If this behavior is
// ever changed deliberately, change it here with intent — not as a side effect.
const ZERO = 0 as unknown as string          // numeric cell holding 0
const FALSE = false as unknown as string     // boolean cell holding false
check('numeric 0 counts as empty (|| semantics)', matchesRerunMode(ZERO, 'empty') === true)
check('numeric 0 is a missing-mode target', matchesRerunMode(ZERO, 'missing') === true)
check('numeric 0 is NOT errored', matchesRerunMode(ZERO, 'errored') === false)
check('false counts as empty (|| semantics)', matchesRerunMode(FALSE, 'empty') === true)
// A non-zero number is a real value and must NOT be re-run.
const NINE = 9 as unknown as string
check('numeric 9 is not empty', matchesRerunMode(NINE, 'empty') === false)
check('numeric 9 is not a missing-mode target', matchesRerunMode(NINE, 'missing') === false)

// --- exported constants ------------------------------------------------------
check('four modes exported', AI_RERUN_MODES.length === 4)
check('default mode is missing (back-compat)', DEFAULT_AI_RERUN_MODE === 'missing')
check('every exported mode is handled',
  AI_RERUN_MODES.every(m => typeof matchesRerunMode(GOOD, m) === 'boolean'))

console.log(failures === 0 ? '\nAll rerun-mode tests passed' : `\n${failures} FAILURES`)
if (failures > 0) process.exit(1)
