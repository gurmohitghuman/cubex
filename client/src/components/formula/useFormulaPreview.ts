import { useEffect, useState } from 'react'
import { formulaAPI, type FormulaColumnBody, type FormulaPreviewResult } from '@/utils/api'
import { FORMULA_PREVIEW_DELAY_MS } from '@/lib/constants'

export interface FormulaPreviewState {
  loading: boolean
  // The newest answer (kept on screen while the next one loads, so the table doesn't flicker).
  result: FormulaPreviewResult | null
  // The server's reason the formula can't be used (a syntax error, an unknown column, a name clash).
  error: string | null
}

const IDLE: FormulaPreviewState = { loading: false, result: null, error: null }

// The Formula dialog's preview: a moment after the formula stops changing, the
// server runs it on the first rows that hold a value (a pure read, free). A
// newer formula drops the older request. body null: nothing to preview yet.
export function useFormulaPreview(sheetId: string, body: FormulaColumnBody | null): FormulaPreviewState {
  const [state, setState] = useState<FormulaPreviewState>(IDLE)
  const key = body ? JSON.stringify(body) : ''
  useEffect(() => {
    if (!key) { setState(IDLE); return }
    setState(s => ({ ...s, loading: true }))
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      formulaAPI.preview(sheetId, JSON.parse(key) as FormulaColumnBody, ctrl.signal)
        .then(result => setState({ loading: false, result, error: null }))
        .catch(e => {
          if (ctrl.signal.aborted) return
          setState({ loading: false, result: null, error: e?.response?.data?.error ?? "Couldn't load the preview." })
        })
    }, FORMULA_PREVIEW_DELAY_MS)
    return () => { clearTimeout(timer); ctrl.abort() }
  }, [sheetId, key])
  return state
}
