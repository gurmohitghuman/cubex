import { useCallback, useRef } from 'react'
import toast from 'react-hot-toast'
import { sheetsAPI, Sheet } from '@/utils/api'

type EmptyFilter = Record<string, 'empty' | 'not_empty'>

interface UseEmptyFilterArgs {
  activeSheet: Sheet | null
  emptyFilter: EmptyFilter
  setEmptyFilter: React.Dispatch<React.SetStateAction<EmptyFilter>>
  // Loud reload of the current sheet. Returns a promise when a reload actually
  // runs so we can AWAIT it to serialize reloads (see chain below).
  reloadActiveSheet: () => Promise<void> | void
}

/**
 * Serializes empty-filter changes. The "empty/non-empty" filter is applied
 * SERVER-SIDE in GET /data (so matches beyond the loaded window are reachable),
 * so each change must PUT the new filter then RELOAD from offset 0 for a
 * filter-aware first page + correct totalRows.
 *
 * Rapid toggles previously fired parallel (PUT, reload) chains with no ordering:
 * the last RESPONSE won, not the last INTENT, so the server could settle on an
 * earlier value while the UI showed a later one — or a stale reload (which
 * re-hydrates emptyFilter + sheetData from the server snapshot it read) could
 * land after a newer change and overwrite it. Symptom: UI and server disagree
 * until a manual refresh. (L6 fixed the failure-revert, not this ordering.)
 *
 * Two guards make last-intent win:
 *  - chainRef serializes the PUT + awaited reload, so the server applies changes
 *    in call order and two reloads are never in flight at once.
 *  - seqRef tags each change; only the NEWEST change reloads and commits React
 *    state. Superseded changes skip the reload (the newest one's reload reflects
 *    the final server state) and stay silent on failure.
 */
export const useEmptyFilter = ({
  activeSheet,
  emptyFilter,
  setEmptyFilter,
  reloadActiveSheet,
}: UseEmptyFilterArgs) => {
  const seqRef = useRef(0)
  // Tail of the serialized PUT chain. New PUTs await it so they hit the server
  // in call order. Always resolves (errors are swallowed here) so one failed
  // PUT can't wedge the chain for later changes.
  const chainRef = useRef<Promise<unknown>>(Promise.resolve())

  return useCallback((column: string, value: 'empty' | 'not_empty' | null) => {
    if (!activeSheet) return
    const sheetId = activeSheet.id

    // Snapshot for optimistic update + failure revert, then compute the next
    // filter. emptyFilter is closed over, so no updater side effect is needed.
    const previousFilter = emptyFilter
    const nextFilter = { ...previousFilter }
    if (!value) delete nextFilter[column]; else nextFilter[column] = value

    const seq = ++seqRef.current
    const isLatest = () => seq === seqRef.current

    // Optimistic React state first (the newest change always reflects intent).
    setEmptyFilter(nextFilter)

    const payload = Object.keys(nextFilter).length === 0 ? null : nextFilter
    // Chain this change's PUT + reload after any in-flight one, and AWAIT the
    // reload inside the chain. Two things fall out of this:
    //  1. The server applies PUTs in click order (settles on the last value).
    //  2. A change's reload fully completes before the next change's PUT starts,
    //     so two reloads can never be in flight at once — a slow early reload
    //     can't resolve after a fast later one and re-hydrate stale state.
    // The reload also runs ONLY for the latest change (isLatest): a superseded
    // change skips its reload entirely, since the latest one's reload reflects
    // the final server state. Awaiting the reload is what closes the clobber
    // window the seq guard alone can't (the trigger is latest at PUT-resolve
    // time, but its slow GET could still land after a newer change without it).
    chainRef.current = chainRef.current
      .then(() => sheetsAPI.updateEmptyFilter(sheetId, payload))
      .then(() => {
        // The sheet may have changed (tab switch) since this PUT was queued.
        if (!isLatest() || activeSheet.id !== sheetId) return
        return reloadActiveSheet()
      })
      .catch(error => {
        console.error('Failed to save empty filter:', error)
        // Only the newest failed change reverts + toasts. A superseded failure
        // is governed by a later change, which owns the final state.
        if (!isLatest()) return
        setEmptyFilter(previousFilter)
        toast.error('Failed to apply filter. Please try again.')
      })
  }, [activeSheet, emptyFilter, setEmptyFilter, reloadActiveSheet])
}
