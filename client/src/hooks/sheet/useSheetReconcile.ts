import { useCallback, useRef } from 'react'
import { tablesAPI, Sheet, Table } from '@/utils/api'

interface UseSheetReconcileArgs {
  setTable: React.Dispatch<React.SetStateAction<Table | null>>
  activeSheetRef: React.MutableRefObject<Sheet | null>
  setActiveSheet: (s: Sheet | null) => void
  tableIdRef: React.MutableRefObject<string | null>
}

// Sheet-list reconciliation + coalesced settle-refetch. The correctness model (kept
// deliberately simple for the 3-sheet, single-user case): server responses are
// AUTHORITATIVE and applied in arrival order; when the in-flight mutation count returns
// to zero, one settle-refetch reads the authoritative list so any out-of-order arrival
// is corrected. No per-op generation gating — that scheme could wrongly discard an
// older-but-committed response.
export const useSheetReconcile = ({
  setTable, activeSheetRef, setActiveSheet, tableIdRef,
}: UseSheetReconcileArgs) => {
  // Apply a sheets list AND reconcile the active sheet from server truth: refresh its
  // metadata (e.g. name) by id, and if it vanished (multi-device drift) fall back to
  // sheets[0] so we never point at a dead sheet.
  const reconcileSheets = useCallback((sheets: Sheet[]) => {
    if (tableIdRef.current == null) return
    setTable(prev => (prev ? { ...prev, sheets } : prev))
    const cur = activeSheetRef.current
    if (cur) {
      const fresh = sheets.find(s => s.id === cur.id)
      if (fresh) { if (fresh.name !== cur.name) setActiveSheet(fresh) }
      else if (sheets.length > 0) setActiveSheet(sheets[0])
    }
  }, [setTable, activeSheetRef, setActiveSheet, tableIdRef])

  // beginOp bumps a mutationEpoch; endOp, when it drains the last in-flight op, launches
  // a settle-refetch. The epoch + pending==0 recheck guard a STALE refetch from
  // overwriting newer truth.
  //
  // Convergence bound (deliberate): the corrective refetch retries with backoff up to
  // SETTLE_MAX_ATTEMPTS (~0.5+1+2+4+8s ≈ 15s of transient-outage tolerance). If the
  // network is down longer than that, the optimistic sheet ORDER/NAME (never cell data)
  // can stay stale until the next sheet op or page load re-syncs — the same "re-sync on
  // next interaction" contract the rest of the app uses for the data layer. We do NOT
  // retry unbounded (runaway-loop risk) or add a bespoke window-focus refetch (net-new
  // surface); a stale tab label after a multi-second outage is a cosmetic, self-healing
  // edge, not data loss.
  const SETTLE_MAX_ATTEMPTS = 5
  const pendingOpsRef = useRef(0)
  const epochRef = useRef(0)
  const beginOp = useCallback(() => { pendingOpsRef.current++; epochRef.current++ }, [])

  // Convergence guarantee comes from endOp: EVERY op, on draining to zero, launches a
  // settle-refetch. So even if one op's corrective refetch exhausts its retries and
  // leaves the tab order/name stale, the NEXT sheet op re-settles from scratch — no
  // separate "needs resync" flag is needed (a prior attempt at one was redundant with
  // this and error-prone, so it was removed).
  const settleRefetch = useCallback((boundTableId: string, epoch: number, attempt: number) => {
    void tablesAPI.getById(boundTableId)
      .then(fresh => {
        if (tableIdRef.current === boundTableId && pendingOpsRef.current === 0
            && epochRef.current === epoch && fresh.sheets) {
          reconcileSheets(fresh.sheets)
        }
      })
      .catch(() => {
        // Retry only while this settle is still the latest (epoch unchanged, quiesced).
        if (attempt < SETTLE_MAX_ATTEMPTS && tableIdRef.current === boundTableId
            && pendingOpsRef.current === 0 && epochRef.current === epoch) {
          setTimeout(() => settleRefetch(boundTableId, epoch, attempt + 1), 500 * 2 ** attempt)
        }
      })
  }, [reconcileSheets, tableIdRef])

  const endOp = useCallback(() => {
    pendingOpsRef.current = Math.max(0, pendingOpsRef.current - 1)
    if (pendingOpsRef.current !== 0) return
    const boundTableId = tableIdRef.current
    if (boundTableId) settleRefetch(boundTableId, epochRef.current, 0)
  }, [settleRefetch, tableIdRef])

  return { reconcileSheets, beginOp, endOp }
}
