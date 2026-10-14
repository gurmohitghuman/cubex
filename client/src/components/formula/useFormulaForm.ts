import { useMemo, useState } from 'react'
import { formulaAPI, type FormulaColumnBody, type FormulaColumnView, type FormulaStartResult } from '@/utils/api'
import { useFormulaPreview } from './useFormulaPreview'

// What the column menu (or a header's auto-run icon) opens the Add Column
// dialog on: a new formula column, or a formula column's setup to edit.
export type FormulaOpenTarget = { mode: 'formula-new' } | { mode: 'formula-edit'; column: string }

interface Args {
  sheetId: string
  // The formula column being edited: its name stays, and saving works every row out again.
  editing: FormulaColumnView | null
  onStarted: (result: FormulaStartResult) => void
}

// The Formula form: the new column's name, the formula (typed, or written by
// AI from plain words, kept as its description), auto-run, the live preview,
// and the submit (its error stays in the form).
export function useFormulaForm({ sheetId, editing, onStarted }: Args) {
  const [name, setName] = useState('')
  const [formula, setFormula] = useState(editing?.formula ?? '')
  const [description, setDescription] = useState<string | null>(editing?.description ?? null)
  const [autoRun, setAutoRun] = useState(editing ? editing.autoRun : true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const column = editing ? editing.column : name.trim()

  // What the server is sent, for the preview and the submit alike (the name
  // too, so a clash shows in the preview before saving).
  const body = useMemo((): FormulaColumnBody | null => {
    if (!formula.trim()) return null
    return { formula, ...(column ? { column } : {}) }
  }, [formula, column])
  const preview = useFormulaPreview(sheetId, body)

  const submit = async () => {
    if (!body || !column || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      // Editing with the box unchanged leaves auto-run as it is: sending it on
      // would lift a pause.
      const run = editing && autoRun === editing.autoRun ? {} : { autoRun }
      onStarted(await formulaAPI.start(sheetId, { ...body, ...(description ? { description } : {}), ...run }))
    } catch (e: any) {
      setError(e?.response?.data?.error || "Couldn't save the formula column. Try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return {
    name, setName, formula, setFormula, description, setDescription, autoRun, setAutoRun, column,
    preview, ready: !!body && !!column, submitting, error, submit,
  }
}
