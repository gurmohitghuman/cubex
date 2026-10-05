// Pure decision for the structural change-poll path (useLiveSheetUpdates),
// isolated in a dependency-free module so the P1-2 race logic is unit-testable
// without pulling React / axios into the test.
//
// After the waitForSaves() barrier resolves, decide whether to LOUD-reload:
//   - Not the current sheet → never reload (the user navigated away).
//   - Dropped a frozen queue → reload UNCONDITIONALLY. While the barrier was
//     waiting, a data-only poll may have fired a SILENT reload that overlaid the
//     now-dropped stale edits onto the post-sort rows AND advanced the tab's
//     generation. Only a loud reload (no overlay) clears that stale paint;
//     honoring the generation-equal short-circuit here would leave the dropped
//     value stuck on the wrong row.
//   - Otherwise → reload only if the tab doesn't already hold the target
//     generation (the 409 recovery, or a concurrent reload, may have done it).
export function shouldLoudReloadAfterBarrier(args: {
  dropped: boolean
  isCurrentSheet: boolean
  holdsTargetGeneration: boolean
}): boolean {
  if (!args.isCurrentSheet) return false
  if (args.dropped) return true
  return !args.holdsTargetGeneration
}
