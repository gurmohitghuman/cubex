import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { aiAPI, webSearchBody, type RunSpend, type WebSearchSettings } from '@/utils/api'
import { AIResult, AIRun, Step } from './types'
import { usePreviewHandlers } from './usePreviewHandlers'

interface Args {
  // Whether the run drawer is open. The progress poll runs ONLY while open —
  // once closed, the sheet page's SSE keeps the grid live, so a closed-drawer
  // 1Hz poll was pure waste that ate ~90% of the global rate-limit budget for
  // a long run (and rate-limited autosave → dropped edits). Reopen re-arms via
  // useDrawerLifecycle's self-heal.
  isOpen: boolean
  sheetId: string
  // The row_generation the sheet was last loaded at. Sent with the preview-commit
  // write so the server 409s if a sort / replace-import happened since the preview
  // was generated (the preview's rowIndex values would otherwise land on the wrong
  // rows — migration 021 fence). Undefined ⇒ server skips the check (back-compat).
  rowGeneration?: number
  columnName: string
  prompt: string
  systemPrompt: string
  model: string
  useOpenRouterWebSearch: boolean
  webSearch: WebSearchSettings
  useWebFetch: boolean
  concurrency: number
  nameError: string
  previewSize: number
  temperature: number
  maxChars: number | undefined
  setStep: (s: Step) => void
  onSuccess: () => void
  onClose: () => void
  onRunStarted?: (runId: string) => void
  resetState: () => void
}

export const useAIRunHandlers = (a: Args) => {
  // Preview generation + preview-commit live in their own hook (file-size split).
  const preview = usePreviewHandlers(a)
  const [runResults, setRunResults] = useState<AIResult[]>([])
  const [currentRun, setCurrentRun] = useState<AIRun | null>(null)
  const [isPolling, setIsPolling] = useState(false)
  // What the run has cost and searched so far.
  const [runSpend, setRunSpend] = useState<RunSpend | null>(null)
  // Latest run id, for the poll's in-flight guard below. A resetState (sheet
  // switch, cancel, terminal) clears currentRun, but a getRun already in
  // flight would still resolve and resurrect the stale run into fresh state.
  const ownedRunId = useRef<string | null>(null)
  ownedRunId.current = currentRun?.id ?? null

  // Poll for run updates when polling is active AND the drawer is open. A
  // closed drawer has no progress UI to feed, and the sheet page's SSE already
  // keeps the grid current, so polling on would only burn rate-limit budget.
  useEffect(() => {
    if (!isPolling || !currentRun?.id || !a.isOpen) return
    const interval = setInterval(async () => {
      if (!currentRun?.id) return
      try {
        const { run, results, spend } = await aiAPI.getRun(currentRun.id)
        if (ownedRunId.current !== run.id) return // reset/superseded while in flight
        setCurrentRun(run as any); setRunResults(results); setRunSpend(spend ?? null)
        if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
          setIsPolling(false)
          // The run worker writes each cell into rows.data live — on a terminal
          // status the sheet already holds the final data, so there is nothing
          // left to review or commit. Refresh the grid and land the (possibly
          // closed) drawer back on a clean configure screen; the run's column
          // now exists, so keeping the old config would only show a
          // duplicate-name error on reopen.
          if (run.status === 'completed') a.onSuccess()
          a.resetState()
        }
      } catch (error) {
        console.error('Failed to poll run status:', error)
        setIsPolling(false)
      }
    }, 1000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPolling, currentRun?.id, a.isOpen])

  const runBody = () => ({
    sheetId: a.sheetId, columnName: a.columnName.trim(), prompt: a.prompt,
    systemPrompt: a.systemPrompt || undefined, model: a.model,
    temperature: a.temperature,
    useOpenRouterWebSearch: a.useOpenRouterWebSearch, useWebFetch: a.useWebFetch,
    ...webSearchBody(a.useOpenRouterWebSearch, a.webSearch),
    maxChars: a.maxChars, concurrency: a.concurrency,
  })

  const handleStartRun = async () => {
    if (!a.columnName.trim() || a.nameError) {
      return toast.error(a.nameError || 'Please provide a valid column name')
    }
    if (!a.model) {
      return toast.error('Choose a model under Configure — or set a default model in Settings.')
    }
    try {
      const result = await aiAPI.startRun(runBody())
      // No success toast — cells visibly start filling with '⏳ Processing...'
      // and the header pill appears, both clear signals. (Credit reuse still
      // happens server-side; result.reusedRows is left unused by design — the
      // owner asked not to surface a "reused N preview results" toast.)
      if (result.runId) a.onRunStarted?.(result.runId)

      const { run, spend } = await aiAPI.getRun(result.runId)
      setCurrentRun(run as any); setRunSpend(spend ?? null); setIsPolling(true); a.setStep('run')
      a.onSuccess()
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to start AI run')
    }
  }

  // Pause/resume/cancel toasts removed — the header pill state changes
  // visibly with each action (Running → Paused → Running → gone).
  const handlePauseRun = async () => {
    if (!currentRun) return
    try { await aiAPI.pauseRun(currentRun.id) }
    catch { toast.error('Failed to pause run') }
  }
  const handleResumeRun = async () => {
    if (!currentRun) return
    try { await aiAPI.resumeRun(currentRun.id) }
    catch { toast.error('Failed to resume run') }
  }
  const handleCancelRun = async () => {
    if (!currentRun) return
    try {
      await aiAPI.cancelRun(currentRun.id)
      a.setStep('configure'); a.resetState()
    } catch { toast.error('Failed to cancel run') }
  }

  return {
    // Preview state + handlers, re-exported so AIColumnModal keeps one hook surface.
    ...preview,
    runResults, runSpend, currentRun, setCurrentRun, isPolling, setIsPolling,
    handleStartRun,
    handlePauseRun, handleResumeRun, handleCancelRun,
  }
}
