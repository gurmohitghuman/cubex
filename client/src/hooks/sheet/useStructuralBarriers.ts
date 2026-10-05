import { useCallback, useRef } from 'react'

// Structural-barrier registry (sheetId → depth), owned by useSheetLoad — not by
// the change-poll — because the commit gate in loadSheetData must cover EVERY
// silent caller (run-completion refresh, Stop refetch, modal callbacks), not
// just poll-scheduled reloads. useLiveSheetUpdates raises/lowers it around
// the waitForSaves barrier and reads it to defer poll-driven reloads.
export function useStructuralBarriers() {
  const structuralBarrierRef = useRef<Map<string, number>>(new Map())
  const beginStructuralBarrier = useCallback((sheetId: string) => {
    const m = structuralBarrierRef.current
    m.set(sheetId, (m.get(sheetId) ?? 0) + 1)
  }, [])
  const endStructuralBarrier = useCallback((sheetId: string) => {
    const m = structuralBarrierRef.current
    const n = (m.get(sheetId) ?? 1) - 1
    if (n > 0) m.set(sheetId, n)
    else m.delete(sheetId)
  }, [])
  const isStructuralBarrierActive = useCallback(
    (sheetId: string) => (structuralBarrierRef.current.get(sheetId) ?? 0) > 0, [])

  return { structuralBarrierRef, beginStructuralBarrier, endStructuralBarrier, isStructuralBarrierActive }
}
