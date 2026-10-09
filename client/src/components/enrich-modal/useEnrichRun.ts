import { useEffect, useRef, useState } from 'react'
import { enrichAPI, httpAPI, settingsAPI, type EnrichRunStatus } from '@/utils/api'
import { ENRICH_RUN_POLL_MS } from '@/lib/constants'

export const RUN_ENDED = new Set(['completed', 'cancelled', 'failed'])
export const runActive = (s: EnrichRunStatus | null) => !!s && !RUN_ENDED.has(s.status)
// Rows of a list job still on their way to their sheet (not those waiting for fields).
export const listAdding = (s: EnrichRunStatus) => !!s.list && s.list.adding.rows + s.list.waitingRoom.rows > 0

// Whether Resume alone can carry a paused run on: not when its own limit
// stopped it, or today's limit has no room for another row (it would pause
// again at once). The paused notice offers the raise for those.
export function plainResumeWorks(s: EnrichRunStatus): boolean {
  if (s.status !== 'paused') return false
  if (s.pauseReason === 'spend_limit') return false
  if (s.pauseReason !== 'daily_limit') return true
  const left = s.dailyLimit.remainingUsd
  return left === null || left + 1e-9 >= (s.maxCostPerRowUsd ?? 0)
}

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback

// The run the drawer's Test and Run steps follow: its lean status
// (GET /api/enrich/runs/:id) every ENRICH_RUN_POLL_MS while the drawer is open
// and the run hasn't ended, and its controls. A control re-reads at once, and
// `onChanged` lets the sheet refresh its run list and cells. The fixes a paused
// run offers in place: Resume with a higher run limit, or a higher daily limit.
export function useEnrichRun(
  runId: string | null, open: boolean, onEnded: (s: EnrichRunStatus) => void, onChanged: () => void,
) {
  const [status, setStatus] = useState<EnrichRunStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const ended = useRef(onEnded)
  ended.current = onEnded

  useEffect(() => {
    if (!runId || !open) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const next = await enrichAPI.runStatus(runId)
        if (!alive) return
        setStatus(next)
        setLoadError(null)
        // A list job's rows are still being added after its last call: keep reading.
        if (RUN_ENDED.has(next.status) && !listAdding(next)) { ended.current(next); return }
      } catch (e) {
        if (!alive) return
        setLoadError(errorOf(e, "Couldn't read the run. Trying again."))
      }
      timer = setTimeout(load, ENRICH_RUN_POLL_MS)
    }
    load()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [runId, open, tick])

  const act = async (fallback: string, fn: () => Promise<unknown>) => {
    if (!runId || busy) return
    setBusy(true)
    setActionError(null)
    try {
      await fn()
      onChanged()
    } catch (e) {
      setActionError(errorOf(e, fallback))
    } finally {
      setBusy(false)
      setTick(t => t + 1)
    }
  }

  return {
    // Only this run's status: a stale one from the run before never shows.
    status: status && status.id === runId ? status : null,
    loadError, actionError, busy,
    // Read again now (and on, while a list job's rows are being added); the
    // sheet refreshes its cells too.
    refresh: () => { setTick(t => t + 1); onChanged() },
    pause: () => act("Couldn't pause the run.", () => httpAPI.controlRun(runId!, 'pause')),
    resume: (spendLimitUsd?: number) =>
      act("Couldn't resume the run.", () => enrichAPI.resumeRun(runId!, spendLimitUsd)),
    cancel: () => act("Couldn't stop the run.", () => httpAPI.controlRun(runId!, 'cancel')),
    raiseDailyAndResume: (limitUsd: number) => act("Couldn't raise the daily limit.", async () => {
      await settingsAPI.setEnrichDailyLimit(limitUsd)
      await enrichAPI.resumeRun(runId!)
    }),
  }
}

export type EnrichRunControls = ReturnType<typeof useEnrichRun>
