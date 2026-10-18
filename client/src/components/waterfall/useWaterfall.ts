// The Waterfall drawer's server reads: the estimate of the draft (debounced,
// the older answer dropped) and the run it started (polled while open).
import { useEffect, useRef, useState } from 'react'
import {
  waterfallAPI, type WaterfallEstimate, type WaterfallRunInput, type WaterfallRunStatus,
} from '@/utils/api/waterfall'
import { ENRICH_RUN_POLL_MS } from '@/lib/constants'

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback
const ESTIMATE_DELAY_MS = 400

export function useWaterfallEstimate(sheetId: string, input: WaterfallRunInput | null, active: boolean) {
  const [estimate, setEstimate] = useState<WaterfallEstimate | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nothingToRun, setNothingToRun] = useState(false)
  const [loading, setLoading] = useState(false)
  const body = input ? JSON.stringify(input) : null
  useEffect(() => {
    if (!active || !body) { setLoading(false); return }
    const ctl = new AbortController()
    setLoading(true)
    const t = setTimeout(() => {
      waterfallAPI.estimate(sheetId, JSON.parse(body), ctl.signal)
        .then(e => { setEstimate(e); setError(null); setNothingToRun(false) })
        .catch(e => {
          if (ctl.signal.aborted) return
          setEstimate(null)
          setError(errorOf(e, "Couldn't estimate it."))
          setNothingToRun(!!e?.response?.data?.nothingToRun)
        })
        .finally(() => { if (!ctl.signal.aborted) setLoading(false) })
    }, ESTIMATE_DELAY_MS)
    return () => { clearTimeout(t); ctl.abort() }
  }, [sheetId, body, active])
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
