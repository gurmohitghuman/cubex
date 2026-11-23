// A waterfall column on the grid: its menu's actions (each run first reads
// its estimate for the confirm, then starts through the waterfall's rerun;
// Edit and View open the drawer). A click on its cells opens the row's trace
// (useTracePanel).
import React, { useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { httpAPI, type HTTPRun, type Sheet } from '@/utils/api'
import { waterfallAPI, type RowsStatus, type WaterfallEstimate } from '@/utils/api/waterfall'
import type { EnrichMenuAction } from '@/components/aggrid/types'
import type { WaterfallOpenTarget } from '@/components/waterfall/WaterfallDrawer'

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

  return {
    onWaterfallAction, pending, confirm, cancel: () => { seq.current++; setPending(null) },
  }
}
