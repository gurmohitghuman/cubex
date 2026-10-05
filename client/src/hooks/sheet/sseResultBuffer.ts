// SSE result coalescing buffer (perf fix #1, client half — see docs/PERF_AUDIT_2026-06.md).
//
// Before: each SSE 'result' event ran its own setSheetData with a FULL rows-array
// copy + an O(n) .find() for the target row. A saturated run emits hundreds/
// thousands of result events, so that was thousands of full-array spreads + linear
// scans, and AG Grid got a brand-new rowData array each time → re-evaluated every
// virtual row. That is the scroll-jank / edit-lag-during-runs cost.
//
// After: events are queued and flushed once per animation frame, coalesced by
// (rowIndex, column) with last-write-wins. One setSheetData per flush, and it
// clones ONLY the rows that actually changed — untouched rows keep their object
// reference. AGGridSpreadsheet then caches its rendered row objects by that source
// ref (a WeakMap), so an untouched row reaches AG Grid as the SAME object and its
// getRowId=__rowIndex diff re-renders only the changed rows. (The two pieces are a
// pair: this immutable-replace + that cache. One without the other doesn't help.)
// We keep React state authoritative (it's load-bearing
// for autosave/reload/overlay/filter) rather than driving the grid imperatively;
// that's deferred until measurement proves it necessary.

import { SheetData } from '@/utils/api'

// One coalesced cell write. `value` is the EXACT final cell string to paint
// (already derived by the caller — verbatim for HTTP extractedFields, derived
// from status/outputValue for AI), so the buffer is display-logic-free.
interface CellDelta { rowIndex: number; column: string; value: string }

const cellKey = (rowIndex: number, column: string) => `${rowIndex}\u0000${column}`

export interface SSEResultBuffer {
  enqueueCell: (rowIndex: number, column: string, value: string) => void
  // Force a synchronous flush now (used before the terminal-status reload so an
  // in-flight batch can't repaint over the fresher silent-reload state).
  flushNow: () => void
  // Cancel any scheduled flush + drop pending deltas (used on unmount / sheet
  // switch so a queued background-sheet batch never lands on the wrong sheet).
  reset: () => void
}

export function createSSEResultBuffer(
  setSheetData: React.Dispatch<React.SetStateAction<SheetData | null>>,
): SSEResultBuffer {
  // Pending coalesced state. Maps (not arrays) so a later write to the same cell
  // overwrites the earlier one in O(1) — last-write-wins within the flush window.
  let pendingCells = new Map<string, CellDelta>()
  let frame: number | null = null

  const flush = () => {
    frame = null
    if (pendingCells.size === 0) return
    const cells = pendingCells
    pendingCells = new Map()

    if (cells.size > 0) {
      // Group deltas by rowIndex so each affected row is cloned exactly once.
      const byRow = new Map<number, CellDelta[]>()
      for (const d of cells.values()) {
        const list = byRow.get(d.rowIndex)
        if (list) list.push(d); else byRow.set(d.rowIndex, [d])
      }
      setSheetData(prev => {
        if (!prev) return prev
        let mutated = false
        // Preserve identity of untouched rows: map returns the SAME object
        // reference for rows with no delta, a shallow-cloned object for rows
        // that changed. AG Grid's getRowId diff then re-renders only the latter.
        const rows = prev.data.rows.map(row => {
          const deltas = byRow.get(row.rowIndex)
          if (!deltas) return row
          mutated = true
          const data = { ...row.data }
          for (const d of deltas) data[d.column] = d.value
          return { ...row, data }
        })
        if (!mutated) return prev
        return { ...prev, data: { ...prev.data, rows } }
      })
    }
  }

  const schedule = () => {
    if (frame !== null) return
    // rAF coalesces a burst into one paint-aligned flush; the ?? fallback keeps
    // it working in non-DOM test contexts.
    frame = (typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(flush)
      : (setTimeout(flush, 16) as unknown as number))
  }

  return {
    enqueueCell(rowIndex, column, value) {
      pendingCells.set(cellKey(rowIndex, column), { rowIndex, column, value })
      schedule()
    },
    flushNow() {
      if (frame !== null) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
        else clearTimeout(frame as unknown as ReturnType<typeof setTimeout>)
        frame = null
      }
      flush()
    },
    reset() {
      if (frame !== null) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
        else clearTimeout(frame as unknown as ReturnType<typeof setTimeout>)
        frame = null
      }
      pendingCells = new Map()
    },
  }
}

// Derive the final cell string for an AI single-column result (mirrors the old
// applySingleCellUpdate logic, kept here so the buffer owns the AI display rule
// and useSheetSSE just enqueues). HTTP results are already-final strings → the
// caller enqueues them verbatim and does NOT call this.
export function deriveAICellValue(status: string, value: any, errorMessage?: string): string {
  if (status === 'failed') return `❌ ${errorMessage || 'Error'}`
  return (value !== undefined && value !== null) ? String(value) : '⏳ Processing...'
}
