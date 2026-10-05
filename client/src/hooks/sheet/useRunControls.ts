import { useMemo } from 'react'
import toast from 'react-hot-toast'
import { aiAPI, httpAPI, AIRun, HTTPRun } from '@/utils/api'

interface UseRunControlsArgs {
  aiRuns: AIRun[]
  httpRuns: HTTPRun[]
  refetch: () => Promise<void> | void
}

export const useRunControls = ({ aiRuns, httpRuns, refetch }: UseRunControlsArgs) => {
  const anyActiveRuns = httpRuns.length > 0 || aiRuns.length > 0
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

  const stopAll = async () => {
    const actions: Promise<any>[] = []
    aiRuns.forEach(r => actions.push(aiAPI.cancelRun(r.id)))
    httpRuns.forEach(r => actions.push(httpAPI.controlRun(r.id, 'cancel')))
    const results = await Promise.allSettled(actions)
    const failed = results.filter(r => r.status === 'rejected').length
    if (failed === results.length) toast.error('Failed to stop runs')
    else if (failed > 0) toast.error(`Stopped some runs (${failed} failed)`)
    // All-succeeded → pills disappear, no toast needed.
    await refetch()
  }

  return useMemo(
    () => ({ anyActiveRuns, anyRunning, pauseAll, resumeAll, stopAll }),
    [anyActiveRuns, anyRunning, aiRuns, httpRuns],
  )
}
