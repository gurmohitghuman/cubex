// The grid's side of the column run controls (useColumnRunControls): what its headers and
// cells read. A column whose run is going shows no "N failed, retry" and its
// cells no play button (a second run on it would be refused). runColumns: each
// column a run fills → its run's main column (the sheet read's runColumns).
//
// The failed counts (a walk over the whole sheet, ~1.2 s at a million rows) are
// read again when a run starts or ends, a run column comes or is renamed, the
// rows are re-meant (a sort or a replacing import elsewhere) or rows go away. Not
// when rows arrive (a webhook stream, an agent's appends): a new row holds no
// failure until a run fills it, and that run's end reads them.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Sheet } from '@/utils/api'
import type { RunByColumn } from '@/components/aggrid/types'
import type { RunCellApi } from '@/components/aggrid/RunCellContext'
import { useColumnRunControls } from './useColumnRunControls'

interface Args {
  activeSheet: Sheet | null
  runColumns?: Record<string, string>
  activeAIRunsByColumn: RunByColumn
  activeHTTPRunsByColumn: RunByColumn
  totalRows: number
  setupSSEConnection: (runId: string, type?: 'ai' | 'http') => void | Promise<void>
  fetchActiveHTTPRuns: (sheetId: string) => unknown
  fetchActiveAIRuns: (sheetId: string) => unknown
  reloadSheetData?: (sheetId: string) => unknown
  rowGenerationRef?: React.MutableRefObject<Map<string, number>>
}

export function useGridRunControls(a: Args) {
  const { activeAIRunsByColumn: ai, activeHTTPRunsByColumn: http, runColumns } = a
  // Content keys, not the objects: those are new on every active-runs refetch and
  // sheet reload, and a new run-cell value would re-render every visible cell.
  const runsKey = useMemo(() => [...Object.keys(ai), ...Object.keys(http)].sort().join('\n'), [ai, http])
  const runColumnsKey = useMemo(() => JSON.stringify(runColumns ?? {}), [runColumns])
  const rowsGone = useRowsGone(a.totalRows)
  const failedKey = `${runsKey}|${runColumnsKey}|${a.activeSheet?.row_generation ?? ''}|${rowsGone}`
  const controls = useColumnRunControls({ ...a, runsKey, failedKey })
  const { rowCost, runRow } = controls.cells
  const runCells = useMemo<RunCellApi>(() => {
    const mains: Record<string, string> = JSON.parse(runColumnsKey)
    const running = new Set(runsKey.split('\n'))
    return { mainOf: column => mains[column] ?? null, running: main => running.has(main), rowCost, runRow }
  }, [runColumnsKey, runsKey, rowCost, runRow])
  const failedRuns = useMemo(() => {
    const running = new Set(runsKey.split('\n'))
    return Object.fromEntries(Object.entries(controls.failed).filter(([column]) => !running.has(column)))
  }, [controls.failed, runsKey])
  return { controls, runCells, failedRuns }
}

// Counts each time the sheet's row count goes down (rows deleted here or elsewhere, a smaller import).
function useRowsGone(totalRows: number): number {
  const [gone, setGone] = useState(0)
  const last = useRef(totalRows)
  useEffect(() => {
    if (totalRows < last.current) setGone(n => n + 1)
    last.current = totalRows
  }, [totalRows])
  return gone
}
