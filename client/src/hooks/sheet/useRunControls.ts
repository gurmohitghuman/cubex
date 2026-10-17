import { useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { aiAPI, httpAPI, runsStopAPI, AIRun, HTTPRun } from '@/utils/api'
import { setupRunsChanged } from '@/lib/setup-runs-signal'

interface UseRunControlsArgs {
  sheetId: string | null
  aiRuns: AIRun[]
  httpRuns: HTTPRun[]
  // A setup is being used on the sheet (its header chip shows): Stop all stops it too.
  setupLive: boolean
  refetch: () => Promise<void> | void
}

// Long enough to read a toast that says where auto-run still starts runs.
const AUTO_RUN_NOTE_MS = 9000

export const useRunControls = ({ sheetId, aiRuns, httpRuns, setupLive, refetch }: UseRunControlsArgs) => {
  const anyActiveRuns = httpRuns.length > 0 || aiRuns.length > 0
  // Stop all shows while anything on the sheet is running: a run, or a setup between its steps.
  const canStopAll = anyActiveRuns || setupLive
  const [stoppingAll, setStoppingAll] = useState(false)
  // A 'pending' run is queued and WILL process — it's pausable (the server pause
  // endpoints accept 'pending'|'running'), so treat it as "running" for the
  // header toggle. Otherwise a sheet whose runs are all still queued shows
  // "Resume" (a no-op, since resumeAll filters on 'paused') and the user can't
  // pause them. Mirrors the pauseAll filter below.
  const isPausable = (status: string) => status === 'running' || status === 'pending'
  const anyRunning =
    httpRuns.some(r => isPausable(r.status)) ||
    aiRuns.some(r => isPausable(r.status))

  const pauseAll = async () => {
    const actions: Promise<any>[] = []
    aiRuns.filter(r => isPausable(r.status)).forEach(r => actions.push(aiAPI.pauseRun(r.id)))
    httpRuns.filter(r => isPausable(r.status)).forEach(r => actions.push(httpAPI.controlRun(r.id, 'pause')))
    const results = await Promise.allSettled(actions)
    const failed = results.filter(r => r.status === 'rejected').length
    // No success toast on the all-succeeded path — pills visibly switch
    // to paused state. Only toast on partial / total failure where the
    // visible state may not match what the user expected.
    if (failed > 0) {
      toast.error(failed === results.length ? 'Failed to pause runs' : `Paused some runs (${failed} failed)`)
    }
    await refetch()
  }

  const resumeAll = async () => {
    const actions: Promise<any>[] = []
    aiRuns.filter(r => r.status === 'paused').forEach(r => actions.push(aiAPI.resumeRun(r.id)))
    httpRuns.filter(r => r.status === 'paused').forEach(r => actions.push(httpAPI.controlRun(r.id, 'resume')))
    const results = await Promise.allSettled(actions)
    const failed = results.filter(r => r.status === 'rejected').length
    if (failed > 0) {
      toast.error(failed === results.length ? 'Failed to resume runs' : `Resumed some runs (${failed} failed)`)
    }
    await refetch()
  }

  // One request stops every run and setup on the sheet, the ones this tab
  // doesn't know about yet included (services/sheet-runs-stop.ts). The toast
  // is the server's own words: what stopped, and where auto-run goes on.
  const stopAll = async () => {
    if (!sheetId || stoppingAll) return
    setStoppingAll(true)
    try {
      const out = await runsStopAPI.stopAll(sheetId)
      const stopped = out.stopped_runs.length + out.stopped_setup_runs.length > 0
      const duration = out.auto_run_on.length || out.auto_run_paused.length ? AUTO_RUN_NOTE_MS : undefined
      if (stopped) toast.success(out.message, { duration })
      else toast(out.message, { duration })
    } catch (e: any) {
      toast.error(e?.response?.data?.error || "Couldn't stop the runs")
    } finally {
      setStoppingAll(false)
      setupRunsChanged(sheetId)
      await refetch()
    }
  }

  return useMemo(
    () => ({ anyActiveRuns, anyRunning, canStopAll, stoppingAll, pauseAll, resumeAll, stopAll }),
    [anyActiveRuns, anyRunning, canStopAll, stoppingAll, aiRuns, httpRuns, sheetId],
  )
}
