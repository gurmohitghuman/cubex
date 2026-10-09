import { useEffect, useState } from 'react'
import { enrichAPI, type EnrichListFieldChoices } from '@/utils/api'

// The fields a list column's results have (and the results waiting for them),
// read for the Test step and Edit, and again when `refreshKey` changes (a run
// moving on, rows being added).
export function useListFields(sheetId: string, column: string | null, active: boolean, refreshKey: string) {
  const [choices, setChoices] = useState<EnrichListFieldChoices | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!active || !column) { setChoices(null); return }
    let alive = true
    setError(null)
    enrichAPI.listFields(sheetId, column)
      .then(c => { if (alive) setChoices(c) })
      .catch(err => { if (alive) setError(err?.response?.data?.error || "Couldn't read the results' fields.") })
    return () => { alive = false }
  }, [sheetId, column, active, refreshKey, attempt])

  return { choices, error, reload: () => setAttempt(a => a + 1) }
}
