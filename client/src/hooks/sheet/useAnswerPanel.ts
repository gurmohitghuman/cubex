import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { enrichAPI, type AnswerView, type Sheet } from '@/utils/api'
import type { AnswerTarget } from '@/components/answer-panel/AnswerPanel'
import { diagnostics } from '@/components/answer-panel/answer-copy'

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback
// A click opens the panel after this long, so a double click edits the cell instead.
const OPEN_AFTER_MS = 300

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
// and "+ Column", which adds a column filled from the stored answers.
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
  const pendingOpen = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  const cancelPending = () => {
    if (pendingOpen.current) clearTimeout(pendingOpen.current)
    pendingOpen.current = null
  }
  // A grid click: open after a moment, unless it turns out to be a double
  // click. A click elsewhere meanwhile (cancelPending) drops it too.
  const clicked = (t: CellTarget, clicks: number) => {
    cancelPending()
    if (clicks > 1) return
    pendingOpen.current = setTimeout(() => { pendingOpen.current = null; open(t) }, OPEN_AFTER_MS)
  }

  const close = () => { seq.current++; setTarget(null); setView(null); setLoading(false); setAdding(false) }

  // A panel never outlives its sheet: its row and actions belong to it.
  const sheetId = a.activeSheet?.id
  useEffect(() => {
    cancelPending()
    if (target && target.sheetId !== sheetId) close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetId])
  useEffect(() => cancelPending, [])

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
    clicked, cancelPending,
    panel: {
      target, view, loading, error, adding, addError, added, diagText,
      onClose: close, onAddField: addField, onRerun: rerun, onCopy: copy,
    },
  }
}
