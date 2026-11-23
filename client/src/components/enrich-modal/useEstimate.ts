import { useEffect, useState } from 'react'
import { enrichAPI, type EnrichEstimate, type EnrichEstimateRequest } from '@/utils/api'
import { useTypedReads } from '@/hooks/useTypedReads'
import { readError } from '@/lib/typedReads'

// The estimate box, recomputed by the server (the same math a run and an
// agent's estimate_only use) as a choice changes: one read at a time, an
// older answer never shown (lib/typedReads.ts). The last answer stays on
// screen while the next one loads; a failed one clears it, so no stale
// figures stay up next to choices they don't match.
export function useEstimate(request: EnrichEstimateRequest | null) {
  const [estimate, setEstimate] = useState<EnrichEstimate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const key = request ? JSON.stringify(request) : ''
  const ask = useTypedReads<EnrichEstimate>(a => {
    setEstimate(a.ok ? a.value : null)
    setError(a.ok ? null : readError(a.error, "Couldn't estimate the cost right now."))
    setLoading(false)
  })

  useEffect(() => {
    if (!request) { setEstimate(null); setError(null); setLoading(false); ask('', null); return }
    setLoading(true)
    ask(key, signal => enrichAPI.estimate(request, signal))
  }, [key, ask]) // eslint-disable-line react-hooks/exhaustive-deps

  return { estimate, error, loading }
}
