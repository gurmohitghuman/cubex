// A run column's cells and their play button (RunRowButton): which run fills
// a column (its main column, where a rerun is asked), whether that run is
// going now, and the row's cost and run (hooks/sheet/useColumnRunControls.ts).
// Given to the cells through React context (it crosses AG Grid's portals), so a
// change re-renders only the cells reading it, never the column definitions.
import { createContext } from 'react'

export interface RunCellApi {
  // The column's main run column, or null when no run fills it.
  mainOf: (column: string) => string | null
  // A run is filling that main column now: no play button meanwhile.
  running: (main: string) => boolean
  // What running the row costs: short for the button, the sentence for its tooltip.
  rowCost: (main: string, row: number) => Promise<{ short: string; label: string }>
  runRow: (main: string, row: number) => void
}

export const RunCellContext = createContext<RunCellApi | null>(null)
