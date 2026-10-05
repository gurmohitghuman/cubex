import { useCallback, useRef } from 'react'
import toast from 'react-hot-toast'
import { sheetsAPI, Sheet } from '@/utils/api'

export type ContainsCond = { type: 'contains'; value: string }
export type ColumnFilters = Record<string, ContainsCond>

interface UseColumnFiltersArgs {
  activeSheet: Sheet | null
  columnFilters: ColumnFilters
  setColumnFilters: React.Dispatch<React.SetStateAction<ColumnFilters>>
  reloadActiveSheet: (opts?: { silent?: boolean }) => Promise<void> | void
}

/**
 * Per-column "text contains" filter changes — the text-search sibling of
 * useEmptyFilter. Applied SERVER-SIDE (matches beyond the loaded window are
 * reachable), so each change PUTs the new filter then RELOADs from offset 0 for
 * a filter-aware first page + correct totalRows. Same last-intent-wins guards as
 * useEmptyFilter: chainRef serializes PUT+reload so the server settles on the
 * last value and two reloads are never in flight; seqRef makes only the newest
 * change reload + commit state (superseded changes skip the reload and stay
 * silent on failure). Passing value '' (or null) clears that column's filter.
 */
export const useColumnFilters = ({
  activeSheet,
  columnFilters,
  setColumnFilters,
  reloadActiveSheet,
}: UseColumnFiltersArgs) => {
  const seqRef = useRef(0)
  const chainRef = useRef<Promise<unknown>>(Promise.resolve())

  return useCallback((column: string, value: string | null) => {
    if (!activeSheet) return
    const sheetId = activeSheet.id

    const previousFilter = columnFilters
    const nextFilter = { ...previousFilter }
    const trimmed = (value ?? '').trim()
    if (!trimmed) delete nextFilter[column]
    else nextFilter[column] = { type: 'contains', value: trimmed }

    const seq = ++seqRef.current
    const isLatest = () => seq === seqRef.current

    setColumnFilters(nextFilter)

    const payload = Object.keys(nextFilter).length === 0 ? null : nextFilter
    chainRef.current = chainRef.current
      .then(() => sheetsAPI.updateColumnFilters(sheetId, payload))
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
        setColumnFilters(previousFilter)
        toast.error('Failed to apply filter. Please try again.')
      })
  }, [activeSheet, columnFilters, setColumnFilters, reloadActiveSheet])
}
