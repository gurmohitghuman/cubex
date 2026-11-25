// A "⏭️ Condition not met" cell's panel ("Why didn't this row run?"): a click opens it at once and reads why (the
// column's "Only run if" rules checked on the row now: free). A double click edits the cell instead, as the answer
// and trace panels do. Moving to another cell keeps the last reasons on screen until the new ones are read.
import { useEffect, useRef, useState } from 'react'
import type { Sheet } from '@/utils/api'
import { skipWhyAPI, type SkipWhy } from '@/utils/api/skip-why'
import type { CellClickInfo } from '@/components/aggrid/types'

export interface WhyTarget { sheetId: string; column: string; row: number; displayRow: number }

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback
const keyOf = (t: WhyTarget) => `${t.sheetId}:${t.column}:${t.row}`

export function useWhyPanel(activeSheet: Sheet | null) {
  const [target, setTarget] = useState<WhyTarget | null>(null)
  const [shown, setShown] = useState<{ cell: WhyTarget; why: SkipWhy } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const editCell = useRef<(() => void) | undefined>(undefined)

  const open = (t: Omit<WhyTarget, 'sheetId'>) => {
    if (!activeSheet) return
    const id = ++seq.current
    const cell: WhyTarget = { ...t, sheetId: activeSheet.id }
    setTarget(cell); setError(null); setLoading(true)
    skipWhyAPI.read(activeSheet.id, t.row, t.column)
      .then(why => { if (seq.current === id) { setShown({ cell, why }); setLoading(false) } })
      .catch(e => {
        if (seq.current !== id) return
        setShown(null); setError(errorOf(e, "Couldn't read why this row didn't run.")); setLoading(false)
      })
  }
  const close = () => { seq.current++; setTarget(null); setShown(null); setLoading(false) }
  const clicked = (t: Omit<WhyTarget, 'sheetId'>, info: Pick<CellClickInfo, 'clicks' | 'edit'>) => {
    if (info.clicks > 1) { close(); return }
    editCell.current = info.edit
    open(t)
  }
  const doubleClickThrough = () => { const edit = editCell.current; close(); edit?.() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (target && target.sheetId !== activeSheet?.id) close() }, [activeSheet?.id])

  return {
    clicked, close,
    panel: {
      target, why: shown?.why ?? null, stale: !!shown && !!target && keyOf(shown.cell) !== keyOf(target),
      loading, error, onClose: close, onDoubleClickThrough: doubleClickThrough,
    },
  }
}
