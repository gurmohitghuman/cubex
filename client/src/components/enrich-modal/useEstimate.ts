import { useEffect, useState } from 'react'
import { enrichAPI, type EnrichEstimate, type EnrichEstimateRequest } from '@/utils/api'

const ESTIMATE_DEBOUNCE_MS = 250

// The estimate box, recomputed by the server (the same math a run and an
// agent's estimate_only use) a moment after a choice changes. The last answer
// stays on screen while the next one loads; a failed one clears it, so no stale
// figures stay up next to choices they don't match.
export function useEstimate(request: EnrichEstimateRequest | null) {
  const [estimate, setEstimate] = useState<EnrichEstimate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const key = request ? JSON.stringify(request) : ''

  useEffect(() => {
    if (!request) { setEstimate(null); setError(null); setLoading(false); return }
    const ctrl = new AbortController()
    setLoading(true)
    const timer = setTimeout(() => {
      enrichAPI.estimate(request, ctrl.signal)
        .then(next => { setEstimate(next); setError(null); setLoading(false) })
        .catch(err => {
          if (ctrl.signal.aborted) return
          setEstimate(null)
          setError(err?.response?.data?.error || "Couldn't estimate the cost right now.")
          setLoading(false)
        })
    }, ESTIMATE_DEBOUNCE_MS)
    return () => { clearTimeout(timer); ctrl.abort() }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  return { estimate, error, loading }
}
