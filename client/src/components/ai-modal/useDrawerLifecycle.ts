import { useEffect, useRef } from 'react'
import { AIRun, Step } from './types'

interface Args {
  isOpen: boolean
  sheetId: string
  step: Step
  currentRun: AIRun | null
  isPolling: boolean
  setIsPolling: (b: boolean) => void
  onClose: () => void
  resetState: () => void
}

// When the AI Column drawer keeps its state vs resets — one place for all of it.
//
// Closing KEEPS everything: the component stays mounted behind the hidden
// drawer, so an in-flight preview keeps streaming into it (like a run keeps
// running) and reopening lands exactly where the user left off, mid-processing
// included. Resets happen only on: "Back to Configure" + close (the explicit
// discard — owner rule: next open starts fresh), switching sheets (the modal
// instance is shared across the SheetPage — no cross-sheet state leaks),
// run-terminal (poll branch in useAIRunHandlers), and opening onto a dead run
// step.
export function useDrawerLifecycle(a: Args) {
  const draftDiscarded = useRef(false)

  const handleClose = () => {
    a.onClose()
    if (draftDiscarded.current) { draftDiscarded.current = false; a.resetState() }
  }

  // "Back to Configure" discarded the persisted draft → the NEXT close resets
  // the retained local state too. A new preview re-arms persistence.
  const discardDraftOnClose = () => { draftDiscarded.current = true }
  const keepDraftOnClose = () => { draftDiscarded.current = false }

  const currentSheet = useRef(a.sheetId)
  useEffect(() => {
    if (currentSheet.current === a.sheetId) return
    currentSheet.current = a.sheetId
    a.resetState()
  }, [a.sheetId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Opening onto the run step with no ACTIVE run (terminal status, or a poll
  // that died while the drawer was closed) must land on configure, never a
  // dead progress screen. If the run is still active but polling stopped
  // (network error), restart it — the poll self-heals.
  useEffect(() => {
    if (!a.isOpen || a.step !== 'run') return
    const active = a.currentRun &&
      ['pending', 'running', 'paused'].includes(a.currentRun.status)
    if (!active) a.resetState()
    else if (!a.isPolling) a.setIsPolling(true)
  }, [a.isOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  return { handleClose, discardDraftOnClose, keepDraftOnClose }
}
