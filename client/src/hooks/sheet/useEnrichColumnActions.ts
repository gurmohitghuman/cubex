import React, { useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { enrichAPI, httpAPI, HTTPRun, Sheet, type EnrichRerunEstimate } from '@/utils/api'
import type { EnrichMenuAction } from '@/components/aggrid/types'
import type { EnrichOpenTarget } from '@/components/enrich-modal/useOpenRequest'
import { RERUN_STATUS, type RerunAction } from '@/components/enrich-modal/rerun-copy'

interface Args {
  activeSheet: Sheet | null
  activeHTTPRuns: HTTPRun[]
  setupSSEConnection: (runId: string, type?: 'ai' | 'http') => void | Promise<void>
  fetchActiveHTTPRuns: (sheetId: string) => unknown
  reloadSheetData?: (sheetId: string) => unknown
  rowGenerationRef?: React.MutableRefObject<Map<string, number>>
  // Opens the enrichment drawer on a column's setup or on a run.
  onOpenEnrichment?: (target: EnrichOpenTarget) => void
}

export interface PendingRerun {
  action: RerunAction
  column: string
  rowIndices?: number[]
  // The sheet's row_generation when the rows were picked (a sort since: 409).
  rowGeneration?: number
  estimate: EnrichRerunEstimate | null
  error: string | null
  starting: boolean
}

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback

// The column menu's Enrichment Actions. Each run (rows not enriched, failed
// rows, selected rows, all rows again) first reads its estimate (a pure read)
// for the confirm, then starts through the enrichment rerun, which runs the
// column's own setup from its newest run. Edit and View open the drawer.
export function useEnrichColumnActions(a: Args) {
  const [pending, setPending] = useState<PendingRerun | null>(null)
  // The confirm on screen: an estimate for an older one is dropped.
  const seq = useRef(0)

  // Selected rows go by row number, fenced by the generation the tab had when
  // they were picked. A run keeps the limit its confirm quoted.
  const body = (p: PendingRerun) => {
    const selected = p.action === 'selected'
    return {
      column: p.column, mode: selected ? 'selected' as const : 'all' as const, status: RERUN_STATUS[p.action],
      ...(selected ? { rowIndexes: p.rowIndices, rowGeneration: p.rowGeneration } : {}),
      ...(p.estimate?.spendLimitUsd != null ? { spendLimitUsd: p.estimate.spendLimitUsd } : {}),
    }
  }

  const afterChange = (sheetId: string) => {
    a.fetchActiveHTTPRuns(sheetId)
    a.reloadSheetData?.(sheetId)
  }

  // rowGeneration: when the rows were picked earlier (the answer panel's row), their generation then.
  const onEnrichAction = (action: EnrichMenuAction, column: string, rowIndices?: number[], rowGeneration?: number) => {
    const sheet = a.activeSheet
    if (!sheet) return
    if (action === 'edit') { a.onOpenEnrichment?.({ kind: 'edit', column }); return }
    const run = a.activeHTTPRuns.find(r => r.master_column_name === column)
    if (action === 'view') { if (run) a.onOpenEnrichment?.({ kind: 'run', runId: run.id }); return }
    if (action === 'stop') {
      if (run) {
        httpAPI.controlRun(run.id, 'cancel').then(() => afterChange(sheet.id))
          .catch(e => toast.error(errorOf(e, "Couldn't stop the enrichment run.")))
      }
      return
    }
    const id = ++seq.current
    const next: PendingRerun = {
      action, column, rowIndices, rowGeneration: rowGeneration ?? a.rowGenerationRef?.current.get(sheet.id),
      estimate: null, error: null, starting: false,
    }
    setPending(next)
    enrichAPI.rerunEstimate(sheet.id, body(next))
      .then(estimate => { if (seq.current === id) setPending(p => (p ? { ...p, estimate } : p)) })
      .catch(e => {
        if (seq.current === id) setPending(p => (p ? { ...p, error: errorOf(e, "Couldn't estimate this run.") } : p))
      })
  }

  const confirm = async () => {
    const sheet = a.activeSheet
    const p = pending
    if (!sheet || !p || p.starting) return
    setPending({ ...p, starting: true, error: null })
    try {
      const out = await enrichAPI.rerun(sheet.id, body(p))
      setPending(null)
      a.setupSSEConnection(out.runId, 'http')
      afterChange(sheet.id)
    } catch (e) {
      setPending(cur => (cur ? { ...cur, starting: false, error: errorOf(e, "Couldn't start the run.") } : cur))
    }
  }

  return { onEnrichAction, pending, confirm, cancel: () => { seq.current++; setPending(null) } }
}
