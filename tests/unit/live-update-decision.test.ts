// Deterministic regression test for the P1-2 race: the loud-reload
// decision after the structural change-poll barrier.
//
// The race: while the barrier waits out its 5s timeout on a frozen queue, a
// data-only poll can fire a SILENT reload that overlays the (about-to-be-
// dropped) stale edits onto the post-sort rows AND advances the tab's
// generation. If the handler then honors the generation-equal short-circuit it
// skips the loud reload and leaves the stale value painted on the wrong row.
// shouldLoudReloadAfterBarrier must reload UNCONDITIONALLY when a frozen queue
// was dropped, regardless of the generation match.
//
// Pure function, no React/DOM — runs under tsx with no DB.

import assert from 'node:assert/strict'
import { shouldLoudReloadAfterBarrier } from '../../client/src/hooks/sheet/liveUpdateDecision'

let failures = 0
function check(label: string, actual: boolean, expected: boolean) {
  try {
    assert.equal(actual, expected)
    console.log('ok  ', label)
  } catch {
    failures++
    console.log('FAIL', label, `\n  got: ${actual}  want: ${expected}`)
  }
}

// THE RACE (the reason this test exists): dropped a frozen queue AND the tab
// already holds the target generation (a concurrent silent reload advanced it).
// Must STILL reload — this is exactly the case the old generation-equal guard
// wrongly short-circuited.
check('dropped + holds-generation → RELOAD (race)',
  shouldLoudReloadAfterBarrier({ dropped: true, isCurrentSheet: true, holdsTargetGeneration: true }), true)

// Dropped and does not hold the generation → reload (the plain P1-2 path).
check('dropped + not-holds-generation → reload',
  shouldLoudReloadAfterBarrier({ dropped: true, isCurrentSheet: true, holdsTargetGeneration: false }), true)

// Not dropped (queue flushed cleanly) + already holds the generation → the 409
// recovery / concurrent reload already handled it, so SKIP the redundant reload.
check('not-dropped + holds-generation → skip (redundant)',
  shouldLoudReloadAfterBarrier({ dropped: false, isCurrentSheet: true, holdsTargetGeneration: true }), false)

// Not dropped + does not hold the generation → reload normally.
check('not-dropped + not-holds-generation → reload',
  shouldLoudReloadAfterBarrier({ dropped: false, isCurrentSheet: true, holdsTargetGeneration: false }), true)

// Navigated away → never touch the current sheet, even if we dropped.
check('not-current-sheet + dropped → no reload',
  shouldLoudReloadAfterBarrier({ dropped: true, isCurrentSheet: false, holdsTargetGeneration: false }), false)
check('not-current-sheet + not-dropped → no reload',
  shouldLoudReloadAfterBarrier({ dropped: false, isCurrentSheet: false, holdsTargetGeneration: false }), false)

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed.`)
  process.exit(1)
}
console.log('\nAll live-update-decision assertions passed.')
