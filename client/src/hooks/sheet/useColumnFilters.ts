import { useCallback, useEffect, useRef } from 'react'
import toast from 'react-hot-toast'
import { sheetsAPI, Sheet } from '@/utils/api'
import { viewChanged } from './viewChanged'
import type { ColumnFilter, ColumnFilters } from '@/lib/filters'

interface UseColumnFiltersArgs {
  activeSheet: Sheet | null
  columnFilters: ColumnFilters
  setColumnFilters: React.Dispatch<React.SetStateAction<ColumnFilters>>
  reloadActiveSheet: (opts?: { silent?: boolean }) => Promise<void> | void
  // Shared with the views hook (useSheetViews), and the view the change is made in.
  chainRef: React.MutableRefObject<Promise<unknown>>
  viewId: string | null
}

/**
 * Per-column filter changes (value, list, number and run-state filters,
 * lib/filters.ts) — the sibling of useEmptyFilter. Applied SERVER-SIDE (matches beyond the loaded window are
 * reachable), so each change PUTs the new filter then RELOADs from offset 0 for
 * a filter-aware first page + correct totalRows. Same last-intent-wins guards as
 * useEmptyFilter: chainRef serializes PUT+reload so the server settles on the
 * last value and two reloads are never in flight; seqRef makes only the newest
 * change reload + commit state (superseded changes skip the reload and stay
 * silent on failure). Passing null clears that column's filter.
 */
export const useColumnFilters = ({
  activeSheet,
  columnFilters,
  setColumnFilters,
  reloadActiveSheet,
  chainRef,
  viewId,
}: UseColumnFiltersArgs) => {
  const seqRef = useRef(0)
  // The filters as of the last change, so changes made one after another in
  // the same tick (Clear filter on every column) build on each other instead
  // of each starting from the same render's state. A load replaces them.
  const latestRef = useRef(columnFilters)
  useEffect(() => { latestRef.current = columnFilters }, [columnFilters])

  return useCallback((column: string, filter: ColumnFilter | null) => {
    if (!activeSheet) return
    const sheetId = activeSheet.id

    const previousFilter = latestRef.current
    const nextFilter = { ...previousFilter }
    if (!filter) delete nextFilter[column]
    else nextFilter[column] = filter

    const seq = ++seqRef.current
    const isLatest = () => seq === seqRef.current

    latestRef.current = nextFilter
    setColumnFilters(nextFilter)

    const payload = Object.keys(nextFilter).length === 0 ? null : nextFilter
    chainRef.current = chainRef.current
      .then(() => sheetsAPI.updateColumnFilters(sheetId, payload, viewId))
      .then(() => {
        if (!isLatest() || activeSheet.id !== sheetId) return
        // SILENT reload: refresh the filter-aware first page WITHOUT flipping
        // isLoading, so the grid stays mounted and the new rows just appear —
        // a loud reload swaps in the "Loading spreadsheet…" spinner for the
        // fetch duration, which reads as a jarring flash on every filter apply.
        return reloadActiveSheet({ silent: true })
      })
      .catch(error => {
        console.error('Failed to save column filter:', error)
        if (!isLatest()) return
        if (viewChanged(error)) return reloadActiveSheet()
        latestRef.current = previousFilter
        setColumnFilters(previousFilter)
        // A 400 says what's wrong with the filter (a value that isn't a number, a gone column).
        const message = error?.response?.status === 400 ? error.response.data?.error : null
        toast.error(message || 'Failed to apply filter. Please try again.')
      })
  }, [activeSheet, setColumnFilters, reloadActiveSheet, chainRef, viewId])
}
