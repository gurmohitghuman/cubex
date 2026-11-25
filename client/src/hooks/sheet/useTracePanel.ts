// A waterfall cell's trace panel: a click on a result cell opens the row's trace at once (TracePanel); a double
// click edits the cell instead, as useAnswerPanel does for answers. "Run this row again" goes through the column
// menu's selected-rows run (useWaterfallColumn), with every step asked afresh. Moving to another cell keeps the last
// trace on screen until the new one is read, as useAnswerPanel does; nothing acts on it meanwhile.
import React, { useEffect, useRef, useState } from 'react'
import type { Sheet } from '@/utils/api'
import { waterfallAPI, type WaterfallTrace } from '@/utils/api/waterfall'
import type { TraceTarget } from '@/components/waterfall/TracePanel'
import type { CellClickInfo } from '@/components/aggrid/types'

interface Args {
  activeSheet: Sheet | null
  rowGenerationRef?: React.MutableRefObject<Map<string, number>>
  onRerunRow: (resultColumn: string, row: number, rowGeneration?: number) => void
}

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback
const cellKey = (t: TraceTarget) => `${t.sheetId}:${t.column}:${t.row}:${t.rowGeneration ?? ''}`

export function useTracePanel(a: Args) {
  const [target, setTarget] = useState<TraceTarget | null>(null)
  const [shown, setShown] = useState<{ cell: TraceTarget; trace: WaterfallTrace } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const editCell = useRef<(() => void) | undefined>(undefined)

  const open = (t: Omit<TraceTarget, 'sheetId' | 'rowGeneration'>) => {
    const sheet = a.activeSheet
    if (!sheet) return
    const id = ++seq.current
    const cell: TraceTarget = { ...t, sheetId: sheet.id, rowGeneration: a.rowGenerationRef?.current.get(sheet.id) }
    setTarget(cell); setError(null); setLoading(true)
    waterfallAPI.trace(sheet.id, t.column, t.row)
      .then(v => { if (seq.current === id) { setShown({ cell, trace: v }); setLoading(false) } })
      .catch(e => {
        if (seq.current !== id) return
        setShown(null); setError(errorOf(e, "Couldn't load this row's trace.")); setLoading(false)
      })
  }
  const close = () => { seq.current++; setTarget(null); setShown(null); setLoading(false) }
  // The trace on screen is another cell's: this one's is on its way.
  const stale = !!shown && !!target && cellKey(shown.cell) !== cellKey(target)
  const clicked = (t: Omit<TraceTarget, 'sheetId' | 'rowGeneration'>, info: Pick<CellClickInfo, 'clicks' | 'edit'>) => {
    if (info.clicks > 1) { close(); return }
    editCell.current = info.edit
    open(t)
  }
  const doubleClickThrough = () => { const edit = editCell.current; close(); edit?.() }

  const sheetId = a.activeSheet?.id
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (target && target.sheetId !== sheetId) close() }, [sheetId])
  const rerunRow = () => {
    if (!shown || !target || stale) return
    const { row, rowGeneration } = target
    close()
    a.onRerunRow(shown.trace.resultColumn, row, rowGeneration)
  }

  return {
    clicked, close,
    panel: {
      target, trace: shown?.trace ?? null, shownCell: shown?.cell ?? null, stale, loading, error, onClose: close,
      onDoubleClickThrough: doubleClickThrough, onRerun: rerunRow,
    },
  }
}
