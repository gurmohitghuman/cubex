// The panels a click on a grid cell opens beside the grid, one at a time: an enrichment or HTTP API cell's answer,
// and a waterfall row's trace. Their state lives here, not in SheetGrid, so a panel opening, its answer arriving and
// its buttons re-render the panel only, never the grid. SheetGrid hands each click over through the handle.
import React, { forwardRef, useImperativeHandle } from 'react'
import type { Sheet } from '@/utils/api'
import type { CellClickInfo } from '@/components/aggrid/types'
import { AnswerPanel } from '@/components/answer-panel/AnswerPanel'
import { TracePanel } from '@/components/waterfall/TracePanel'
import { useAnswerPanel } from '@/hooks/sheet/useAnswerPanel'
import { useTracePanel } from '@/hooks/sheet/useTracePanel'

export interface PanelCell { column: string; row: number; displayRow: number }
type Click = Pick<CellClickInfo, 'clicks' | 'edit'>
export interface CellPanelsHandle {
  answer: (cell: PanelCell, click: Click) => void
  trace: (cell: PanelCell, click: Click) => void
}

interface Props {
  activeSheet: Sheet | null
  reloadSheetData?: (sheetId: string) => unknown
  rowGenerationRef?: React.MutableRefObject<Map<string, number>>
  // "Rerun this row" and "Run this row again": through the column menu's selected-rows run and its confirm.
  onRerunAnswerRow: (statusColumn: string, row: number, rowGeneration?: number) => void
  onRerunTraceRow: (resultColumn: string, row: number, rowGeneration?: number) => void
}

export const CellPanels = forwardRef<CellPanelsHandle, Props>(function CellPanels(p, ref) {
  const answers = useAnswerPanel({
    activeSheet: p.activeSheet, reloadSheetData: p.reloadSheetData,
    rowGeneration: () => (p.activeSheet ? p.rowGenerationRef?.current.get(p.activeSheet.id) : undefined),
    onRerunRow: p.onRerunAnswerRow,
  })
  const traces = useTracePanel({
    activeSheet: p.activeSheet, rowGenerationRef: p.rowGenerationRef, onRerunRow: p.onRerunTraceRow,
  })
  // Rebuilt on each render, so a click always reaches the panels' latest state.
  useImperativeHandle(ref, () => ({
    answer: (cell, click) => { traces.close(); answers.clicked(cell, click) },
    trace: (cell, click) => { answers.close(); traces.clicked(cell, click) },
  }))
  return (
    <>
      <AnswerPanel {...answers.panel} />
      <TracePanel {...traces.panel} />
    </>
  )
})
