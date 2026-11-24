import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { enrichAPI, type AnswerView, type Sheet } from '@/utils/api'
import type { AnswerTarget } from '@/components/answer-panel/AnswerPanel'
import { diagnostics } from '@/components/answer-panel/answer-copy'
import type { CellClickInfo } from '@/components/aggrid/types'

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback

type CellTarget = Omit<AnswerTarget, 'sheetId' | 'rowGeneration'>

interface Args {
  activeSheet: Sheet | null
  reloadSheetData?: (sheetId: string) => unknown
  // The sheet's row_generation now, stamped on the panel when it opens.
  rowGeneration: () => number | undefined
  // The column menu's "Run Selected Rows" on one row, fenced by the generation
  // the row was picked under: its confirm says it costs again.
  onRerunRow: (statusColumn: string, rowIndex: number, rowGeneration?: number) => void
}

// The answer panel's state: the cell it shows, its answer (read per click),
// and "Add as column", which adds a column filled from the stored answers.
export function useAnswerPanel(a: Args) {
  const [target, setTarget] = useState<AnswerTarget | null>(null)
  const [view, setView] = useState<AnswerView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [added, setAdded] = useState<string | null>(null)
  const [diagText, setDiagText] = useState<string | null>(null)
  // The panel on screen: anything for an earlier click (a read, an add) is dropped.
  const seq = useRef(0)
  // Starts editing the cell the panel opened on (CellClickInfo.edit).
  const editCell = useRef<(() => void) | undefined>(undefined)

  const load = (t: AnswerTarget) => {
    const id = seq.current
    setLoading(true)
    enrichAPI.answer(t.sheetId, t.column, t.row)
      .then(v => { if (seq.current === id) { setView(v); setError(null) } })
      .catch(e => { if (seq.current === id) setError(errorOf(e, "Couldn't load this answer.")) })
      .finally(() => { if (seq.current === id) setLoading(false) })
  }

  const open = (t: CellTarget) => {
    if (!a.activeSheet) return
    seq.current++
    const full: AnswerTarget = { ...t, sheetId: a.activeSheet.id, rowGeneration: a.rowGeneration() }
    setTarget(full); setView(null); setError(null); setAddError(null); setAdded(null); setDiagText(null)
    setAdding(false)
    load(full)
  }

  const close = () => { seq.current++; setTarget(null); setView(null); setLoading(false); setAdding(false) }

  // A grid click opens the panel at once, with no wait. A double click edits the cell, as the grid's own double
  // click does: its second click closes the panel the first one opened. When that second click lands on the panel
  // (the cell was under it), the panel passes it on (doubleClickThrough).
  const clicked = (t: CellTarget, info: Pick<CellClickInfo, 'clicks' | 'edit'>) => {
    if (info.clicks > 1) { close(); return }
    editCell.current = info.edit
    open(t)
  }
  const doubleClickThrough = () => { const edit = editCell.current; close(); edit?.() }

  // A panel never outlives its sheet: its row and actions belong to it.
  const sheetId = a.activeSheet?.id
  useEffect(() => {
    if (target && target.sheetId !== sheetId) close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetId])

  const addField = async (jsonPath: string, name: string) => {
    const t = target
    if (!t || adding) return
    const id = seq.current
    setAdding(true); setAddError(null); setAdded(null)
    try {
      const out = await enrichAPI.addField(t.sheetId, { column: t.column, jsonPath, name, row: t.row })
      a.reloadSheetData?.(t.sheetId)
      if (seq.current !== id) return
      setAdded(out.column)
      load(t)
    } catch (e) {
      if (seq.current === id) setAddError(errorOf(e, "Couldn't add the column."))
    } finally {
      if (seq.current === id) setAdding(false)
    }
  }

  const rerun = () => {
    if (!view || !target) return
    const { statusColumn } = view
    const { row, rowGeneration } = target
    close()
    a.onRerunRow(statusColumn, row, rowGeneration)
  }

  // Off HTTPS (a plain-HTTP install on the LAN) the browser has no clipboard
  // API: the text shows in the panel to copy by hand.
  const copy = async () => {
    if (!view || !target) return
    const text = diagnostics(view, target.displayRow)
    try {
      if (!navigator.clipboard) throw new Error('no clipboard')
      await navigator.clipboard.writeText(text)
      toast.success('Diagnostics copied.')
    } catch {
      setDiagText(text)
    }
  }

  return {
    clicked, close,
    panel: {
      target, view, loading, error, adding, addError, added, diagText,
      onClose: close, onDoubleClickThrough: doubleClickThrough, onAddField: addField, onRerun: rerun, onCopy: copy,
    },
  }
}
