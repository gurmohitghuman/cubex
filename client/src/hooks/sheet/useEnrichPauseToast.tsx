import React, { useCallback, useRef } from 'react'
import toast from 'react-hot-toast'
import { draftRunOnScreen } from '@/components/enrich-modal/useEnrichmentDraft'
import type { EnrichOpenTarget } from '@/components/enrich-modal/useOpenRequest'

interface Modals {
  showEnrichmentDrawer: boolean
  enrichWatch: string | null
  openEnrichment: (target: EnrichOpenTarget) => void
}

// When an enrichment run pauses itself (its limit, today's limit, the treg
// balance or key, treg unreachable): the open drawer already shows the reason
// and its fix in place, so no toast then. Otherwise a toast says why, with
// "Show" opening the run in the drawer, where the fix is.
export function useEnrichPauseToast(currentSheetIdRef: React.MutableRefObject<string | null>, modals: Modals) {
  const ref = useRef(modals)
  ref.current = modals
  return useCallback((runId: string, reason: string) => {
    const sheetId = currentSheetIdRef.current
    const onScreen = ref.current.enrichWatch ?? (sheetId ? draftRunOnScreen(sheetId) : null)
    if (ref.current.showEnrichmentDrawer && onScreen === runId) return
    toast.error(t => (
      <span className="flex items-start gap-3" data-testid="enrich-pause-toast">
        <span>Paused: {reason}</span>
        <button type="button" className="underline whitespace-nowrap"
          onClick={() => { toast.dismiss(t.id); ref.current.openEnrichment({ kind: 'run', runId }) }}>
          Show
        </button>
      </span>
    ), { id: `enrich-paused-${runId}` })
  }, [currentSheetIdRef])
}
