// Regression test for P2-8: clampCellChars — surrogate-safe per-cell truncation.
//
// Truncates to at most `max` UTF-16 code units WITHOUT splitting a surrogate
// pair (a lone surrogate would corrupt the JSON stored in rows.data), and
// appends a short marker so a clipped cell reads as intentionally shortened.
// Within the cap → returned unchanged (common case, no allocation).
//
// Pure function — runs under tsx with a throwaway DB_PATH (csv-safety's import
// graph opens a DB).

import assert from 'node:assert/strict'
import csvSafety from '../../server/src/lib/csv-safety'

const { clampCellChars } = csvSafety

if (!process.env.DB_PATH) {
  console.error('Refusing to run without a throwaway DB_PATH set.')
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

const MARKER = '…[truncated]'

// Under the cap → unchanged (identity, no marker).
check('within cap → unchanged', clampCellChars('hello', 10) === 'hello')
check('exactly at cap → unchanged', clampCellChars('a'.repeat(10), 10) === 'a'.repeat(10))

// Over the cap → RESULT is within `max` (marker counted INSIDE the budget —
// the advertised cap is the real stored ceiling).
const clamped = clampCellChars('a'.repeat(100), 40)
check('over cap → result length <= max (marker inside budget)', clamped.length <= 40)
check('over cap → ends with the marker', clamped.endsWith(MARKER))
check('over cap → is actually shorter than the input', clamped.length < 100)
// The realistic caps: a huge value clamped to the enrichment cap stays <= cap.
check('enrichment cap: result <= 200000', clampCellChars('x'.repeat(500000), 200000).length <= 200000)
check('basic cap: result <= 8000', clampCellChars('x'.repeat(50000), 8000).length <= 8000)
// max smaller than the marker → hard slice, no marker, still <= max.
check('tiny max (< marker) → hard cap, length <= max', clampCellChars('abcdef', 3).length <= 3)

// Surrogate safety: a 4-byte emoji is a surrogate PAIR (2 UTF-16 units). The cut
// (max - markerLen) must not land mid-pair. Build a string where the emoji
// straddles the reserved cut so the back-off engages, then assert NO lone
// surrogate ends the content. Use a max comfortably above the marker length.
const emoji = '\u{1F600}' // 😀 = D83D DE00
const M = MARKER.length
// Content before the marker is (max - M) chars; place the emoji so its high
// half sits exactly at (max - M - 1). Pad with 'a's, then the emoji, then junk.
const max = M + 6
const padded = 'a'.repeat(max - M - 1) + emoji + 'zzzzzz'
const clampedPair = clampCellChars(padded, max)
check('surrogate: result length <= max', clampedPair.length <= max)
const contentPair = clampedPair.endsWith(MARKER) ? clampedPair.slice(0, -M) : clampedPair
const lastCode = contentPair.length ? contentPair.charCodeAt(contentPair.length - 1) : 0
check('surrogate: no lone high surrogate at the cut', !(lastCode >= 0xd800 && lastCode <= 0xdbff))

if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1) }
console.log('\nAll clamp-cell-chars assertions passed.')
