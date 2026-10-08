import { useState } from 'react'
import { enrichAPI, type EnrichRunRequest } from '@/utils/api'

// Starting a run from Set up or the Test step: one request at a time, its
// error in place (the drawer shows it under the buttons; no toast).
export function useRunStart(sheetId: string, onStarted: (runId: string, statusColumn: string, test: boolean) => void) {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = async (body: EnrichRunRequest | null, test: boolean) => {
    if (!body || starting) return
    setStarting(true)
    setError(null)
    try {
      const out = await enrichAPI.startRun(sheetId, body)
      onStarted(out.runId, out.statusColumn, test)
    } catch (e: any) {
      setError(e?.response?.data?.error || "Couldn't start the run. Try again.")
    } finally {
      setStarting(false)
    }
  }
  return { start, starting, error, clearError: () => setError(null) }
}
