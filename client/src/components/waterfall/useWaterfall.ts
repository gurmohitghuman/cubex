// The Waterfall drawer's server reads: the estimate of the draft (read as it
// changes, the older answer dropped) and the run it started (polled while open).
import { useEffect, useRef, useState } from 'react'
import {
  waterfallAPI, type WaterfallEstimate, type WaterfallRunInput, type WaterfallRunStatus,
} from '@/utils/api/waterfall'
import { ENRICH_RUN_POLL_MS } from '@/lib/constants'
import { useTypedReads } from '@/hooks/useTypedReads'

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback

// One read at a time, an older answer never shown (lib/typedReads.ts).
export function useWaterfallEstimate(sheetId: string, input: WaterfallRunInput | null, active: boolean) {
  const [estimate, setEstimate] = useState<WaterfallEstimate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nothingToRun, setNothingToRun] = useState(false)
  const [loading, setLoading] = useState(false)
  // The estimate doesn't depend on the retry count: undefined drops it from the JSON, so moving the
  // slider leaves the body as it was and asks for no new estimate.
  const body = input ? JSON.stringify({ ...input, rateLimitRetries: undefined }) : null
  const ask = useTypedReads<WaterfallEstimate>(a => {
    setEstimate(a.ok ? a.value : null)
    setError(a.ok ? null : errorOf(a.error, "Couldn't estimate it."))
    setNothingToRun(!a.ok && !!(a.error as any)?.response?.data?.nothingToRun)
    setLoading(false)
  })
  useEffect(() => {
    if (!active || !body) { setLoading(false); ask('', null); return }
    setLoading(true)
    ask(`${sheetId}\n${body}`, signal => waterfallAPI.estimate(sheetId, JSON.parse(body), signal))
  }, [sheetId, body, active, ask])
  return { estimate, error, nothingToRun, loading }
}

export const runActive = (s: WaterfallRunStatus | null) =>
  !!s && (s.starting || s.status === 'pending' || s.status === 'running' || s.status === 'paused')

export function useWaterfallRun(runId: string | null, active: boolean, onEnded: () => void) {
  const [status, setStatus] = useState<WaterfallRunStatus | null>(null)
  const ended = useRef(onEnded)
  ended.current = onEnded
  useEffect(() => {
    setStatus(null)
    if (!runId || !active) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const s = await waterfallAPI.runStatus(runId)
        if (!alive) return
        setStatus(s)
        if (!runActive(s)) { ended.current(); return }
      } catch { /* the next tick asks again */ }
      if (alive) timer = setTimeout(tick, ENRICH_RUN_POLL_MS)
    }
    void tick()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [runId, active])
  return status
}
