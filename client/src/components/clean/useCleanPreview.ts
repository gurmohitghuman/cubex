import { useEffect, useState } from 'react'
import { cleanAPI, type CleanColumnBody, type CleanPreviewResult } from '@/utils/api'
import { CLEAN_PREVIEW_DELAY_MS } from '@/lib/constants'

export interface CleanPreviewState {
  loading: boolean
  // The newest answer (kept on screen while the next one loads, so the table doesn't flicker).
  result: CleanPreviewResult | null
  // The server's reason the setup can't be used (a name clash, an unknown column, a bad country).
  error: string | null
}

const IDLE: CleanPreviewState = { loading: false, result: null, error: null }

// The Clean data dialog's preview: a moment after the form stops changing, the
// server cleans the first rows that hold a value (a pure read, free). A newer
// form drops the older request. body null: nothing to preview yet.
export function useCleanPreview(sheetId: string, body: CleanColumnBody | null): CleanPreviewState {
  const [state, setState] = useState<CleanPreviewState>(IDLE)
  // The form's fields, as one value the effect can compare.
  const key = body ? JSON.stringify(body) : ''
  useEffect(() => {
    if (!key) { setState(IDLE); return }
    setState(s => ({ ...s, loading: true }))
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      cleanAPI.preview(sheetId, JSON.parse(key) as CleanColumnBody, ctrl.signal)
        .then(result => setState({ loading: false, result, error: null }))
        .catch(e => {
          if (ctrl.signal.aborted) return
          setState({ loading: false, result: null, error: e?.response?.data?.error ?? "Couldn't load the preview." })
        })
    }, CLEAN_PREVIEW_DELAY_MS)
    return () => { clearTimeout(timer); ctrl.abort() }
  }, [sheetId, key])
  return state
}
