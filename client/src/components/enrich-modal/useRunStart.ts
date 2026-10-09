import { useState } from 'react'
import { enrichAPI, type EnrichRunRequest } from '@/utils/api'
import type { OnStarted } from './draft'

// Starting a run from Set up or the Test step: one request at a time, its
// error in place (the drawer shows it under the buttons; no toast). An error
// about one field (a new sheet's name) goes to onFieldError, shown at that field.
export function useRunStart(
  sheetId: string, onStarted: OnStarted, onFieldError?: (field: string, message: string) => void,
) {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = async (body: EnrichRunRequest | null, test: boolean) => {
    if (!body || starting) return
    setStarting(true)
    setError(null)
    try {
      const out = await enrichAPI.startRun(sheetId, body)
      onStarted(out.runId, out.statusColumn, test, out.destSheetId ?? null)
    } catch (e: any) {
      const message: string = e?.response?.data?.error || "Couldn't start the run. Try again."
      const field = e?.response?.data?.field
      if (typeof field === 'string' && onFieldError) onFieldError(field, message)
      else setError(message)
    } finally {
      setStarting(false)
    }
  }
  return { start, starting, error, clearError: () => setError(null) }
}
