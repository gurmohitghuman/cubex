// A waterfall cell's trace panel: a click on a result cell opens the row's trace at once (TracePanel); a double
// click edits the cell instead, as useAnswerPanel does for answers. "Run this row again" goes through the column
// menu's selected-rows run (useWaterfallColumn), with every step asked afresh.
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

export function useTracePanel(a: Args) {
  const [target, setTarget] = useState<TraceTarget | null>(null)
  const [trace, setTrace] = useState<WaterfallTrace | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const editCell = useRef<(() => void) | undefined>(undefined)

  const open = (t: Omit<TraceTarget, 'sheetId' | 'rowGeneration'>) => {
    const sheet = a.activeSheet
    if (!sheet) return
    const id = ++seq.current
    setTarget({ ...t, sheetId: sheet.id, rowGeneration: a.rowGenerationRef?.current.get(sheet.id) })
    setTrace(null); setError(null); setLoading(true)
    waterfallAPI.trace(sheet.id, t.column, t.row)
      .then(v => { if (seq.current === id) setTrace(v) })
      .catch(e => { if (seq.current === id) setError(errorOf(e, "Couldn't load this row's trace.")) })
      .finally(() => { if (seq.current === id) setLoading(false) })
  }
  const close = () => { seq.current++; setTarget(null); setTrace(null) }
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
    if (!trace || !target) return
    const { row, rowGeneration } = target
    close()
    a.onRerunRow(trace.resultColumn, row, rowGeneration)
  }

  return {
    clicked, close,
    panel: {
      target, trace, loading, error, onClose: close, onDoubleClickThrough: doubleClickThrough, onRerun: rerunRow,
    },
  }
}
