// A waterfall column on the grid: its menu's actions (each run first reads
// its estimate for the confirm, then starts through the waterfall's rerun;
// Edit and View open the drawer) and a click on its cells, which opens the
// row's trace after a moment (a double click edits instead).
import React, { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { httpAPI, type HTTPRun, type Sheet } from '@/utils/api'
import { waterfallAPI, type RowsStatus, type WaterfallEstimate, type WaterfallTrace } from '@/utils/api/waterfall'
import type { EnrichMenuAction } from '@/components/aggrid/types'
import type { WaterfallOpenTarget } from '@/components/waterfall/WaterfallDrawer'
import type { TraceTarget } from '@/components/waterfall/TracePanel'

interface Args {
  activeSheet: Sheet | null
  activeHTTPRuns: HTTPRun[]
  setupSSEConnection: (runId: string, type?: 'ai' | 'http') => void | Promise<void>
  fetchActiveHTTPRuns: (sheetId: string) => unknown
  reloadSheetData?: (sheetId: string) => unknown
  rowGenerationRef?: React.MutableRefObject<Map<string, number>>
  onOpenWaterfall?: (target: WaterfallOpenTarget) => void
}

// stale: rows not run yet, and rows whose result was made from input cells that changed since.
export type WaterfallRerunAction = 'stale' | 'failed' | 'selected' | 'all'
export interface PendingWaterfallRun {
  action: WaterfallRerunAction; column: string; rowIndices?: number[]; rowGeneration?: number
  noReuse?: boolean                    // "Run this row again": every step asked afresh
  estimate: WaterfallEstimate | null; error: string | null; starting: boolean
}

const STATUS: Record<WaterfallRerunAction, RowsStatus> = {
  stale: 'empty_or_out_of_date', failed: 'failed', selected: 'any', all: 'any',
}
const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback
const OPEN_AFTER_MS = 300

export function useWaterfallColumn(a: Args) {
  const [pending, setPending] = useState<PendingWaterfallRun | null>(null)
  const seq = useRef(0)
  const body = (p: PendingWaterfallRun) => ({
    column: p.column, status: STATUS[p.action],
    ...(p.action === 'selected' ? { rowIndexes: p.rowIndices, rowGeneration: p.rowGeneration } : {}),
    ...(p.estimate?.run_limit_usd != null ? { spendLimitUsd: p.estimate.run_limit_usd } : {}),
    ...(p.noReuse ? { noReuse: true } : {}),
  })
  const afterChange = (sheetId: string) => { a.fetchActiveHTTPRuns(sheetId); a.reloadSheetData?.(sheetId) }

  const onWaterfallAction = (
    action: EnrichMenuAction, column: string, rowIndices?: number[], rowGeneration?: number, noReuse = false,
  ) => {
    const sheet = a.activeSheet
    if (!sheet) return
    if (action === 'edit') { a.onOpenWaterfall?.({ kind: 'edit', column }); return }
    const run = a.activeHTTPRuns.find(r => r.master_column_name === column)
    if (action === 'view') { if (run) a.onOpenWaterfall?.({ kind: 'run', runId: run.id }); return }
    if (action === 'stop') {
      if (run) {
        httpAPI.controlRun(run.id, 'cancel').then(() => afterChange(sheet.id))
          .catch(e => toast.error(errorOf(e, "Couldn't stop the waterfall run.")))
      }
      return
    }
    const id = ++seq.current
    const next: PendingWaterfallRun = {
      action, column, rowIndices, rowGeneration: rowGeneration ?? a.rowGenerationRef?.current.get(sheet.id),
      noReuse, estimate: null, error: null, starting: false,
    }
    setPending(next)
    waterfallAPI.rerunEstimate(sheet.id, body(next))
      .then(estimate => { if (seq.current === id) setPending(p => (p ? { ...p, estimate } : p)) })
      .catch(e => {
        if (seq.current === id) setPending(p => (p ? { ...p, error: errorOf(e, "Couldn't estimate it.") } : p))
      })
  }

  const confirm = async () => {
    const sheet = a.activeSheet
    const p = pending
    if (!sheet || !p || p.starting) return
    setPending({ ...p, starting: true, error: null })
    try {
      const out = await waterfallAPI.rerun(sheet.id, body(p))
      setPending(null)
      a.setupSSEConnection(out.runId, 'http')
      afterChange(sheet.id)
    } catch (e) {
      setPending(cur => (cur ? { ...cur, starting: false, error: errorOf(e, "Couldn't start the run.") } : cur))
    }
  }

  // The trace panel.
  const [target, setTarget] = useState<TraceTarget | null>(null)
  const [trace, setTrace] = useState<WaterfallTrace | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const traceSeq = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPendingTrace = () => { if (timer.current) clearTimeout(timer.current); timer.current = null }
  const openTrace = (t: Omit<TraceTarget, 'sheetId' | 'rowGeneration'>) => {
    const sheet = a.activeSheet
    if (!sheet) return
    const id = ++traceSeq.current
    setTarget({ ...t, sheetId: sheet.id, rowGeneration: a.rowGenerationRef?.current.get(sheet.id) })
    setTrace(null); setError(null); setLoading(true)
    waterfallAPI.trace(sheet.id, t.column, t.row)
      .then(v => { if (traceSeq.current === id) setTrace(v) })
      .catch(e => { if (traceSeq.current === id) setError(errorOf(e, "Couldn't load this row's trace.")) })
      .finally(() => { if (traceSeq.current === id) setLoading(false) })
  }
  const traceClicked = (t: Omit<TraceTarget, 'sheetId' | 'rowGeneration'>, clicks: number) => {
    cancelPendingTrace()
    if (clicks > 1) return
    timer.current = setTimeout(() => { timer.current = null; openTrace(t) }, OPEN_AFTER_MS)
  }
  const closeTrace = () => { traceSeq.current++; setTarget(null); setTrace(null) }
  const sheetId = a.activeSheet?.id
  // eslint-disable-next-line
  useEffect(() => { cancelPendingTrace(); if (target && target.sheetId !== sheetId) closeTrace() }, [sheetId])
  useEffect(() => cancelPendingTrace, [])
  const rerunRow = () => {
    if (!trace || !target) return
    const { row, rowGeneration } = target
    closeTrace()
    // A row run again asks every step afresh, not its own earlier answer.
    onWaterfallAction('selected', trace.resultColumn, [row], rowGeneration, true)
  }

  return {
    onWaterfallAction, pending, confirm, cancel: () => { seq.current++; setPending(null) },
    traceClicked, cancelPendingTrace,
    tracePanel: { target, trace, loading, error, onClose: closeTrace, onRerun: rerunRow },
  }
}
