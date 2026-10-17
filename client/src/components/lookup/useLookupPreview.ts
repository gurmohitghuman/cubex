import { useEffect, useState } from 'react'
import { lookupAPI, type LookupColumnBody, type LookupPreviewResult } from '@/utils/api'
import { LOOKUP_PREVIEW_DELAY_MS } from '@/lib/constants'

export interface LookupPreviewState {
  loading: boolean
  // The newest answer (kept on screen while the next one loads, so the table doesn't flicker).
  result: LookupPreviewResult | null
  // The server's reason the lookup can't be set up so (a column gone, a name clash).
  error: string | null
}

const IDLE: LookupPreviewState = { loading: false, result: null, error: null }

// The Lookup dialog's preview: a moment after the settings stop changing, the
// server looks up the first rows that hold a value (a pure read, free). Newer
// settings drop the older request. body null: nothing to preview yet.
export function useLookupPreview(sheetId: string, body: LookupColumnBody | null): LookupPreviewState {
  const [state, setState] = useState<LookupPreviewState>(IDLE)
  const key = body ? JSON.stringify(body) : ''
  useEffect(() => {
    if (!key) { setState(IDLE); return }
    setState(s => ({ ...s, loading: true }))
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      lookupAPI.preview(sheetId, JSON.parse(key) as LookupColumnBody, ctrl.signal)
        .then(result => setState({ loading: false, result, error: null }))
        .catch(e => {
          if (ctrl.signal.aborted) return
          setState({ loading: false, result: null, error: e?.response?.data?.error ?? "Couldn't load the preview." })
        })
    }, LOOKUP_PREVIEW_DELAY_MS)
    return () => { clearTimeout(timer); ctrl.abort() }
  }, [sheetId, key])
  return state
}
