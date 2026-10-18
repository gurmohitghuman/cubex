// The run controls of a sheet's grid (AI, HTTP API, enrichment and waterfall
// columns): the header's "N failed, retry" (useFailedRuns) and its one-click
// retry, a cell's play button (its row's cost read on hover, then one click
// runs it) and the AI and HTTP API menus' runs, each confirmed with its
// estimate first. Enrichment and waterfall menus keep their own confirms.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import type { Sheet } from '@/utils/api'
import {
  runControlsAPI, type RunControlEstimate, type RunControlStarted, type RunRows,
} from '@/utils/api/run-controls'
import { rowCostLabel, rowCostShort } from '@/lib/run-controls-copy'
import { plural } from '@/lib/utils'
import { useFailedRuns } from './useFailedRuns'

interface Args {
  activeSheet: Sheet | null
  setupSSEConnection: (runId: string, type?: 'ai' | 'http') => void | Promise<void>
  fetchActiveHTTPRuns: (sheetId: string) => unknown
  fetchActiveAIRuns: (sheetId: string) => unknown
  reloadSheetData?: (sheetId: string) => unknown
  rowGenerationRef?: React.MutableRefObject<Map<string, number>>
  // Changes whenever a run starts or ends on the sheet (its active runs' columns).
  runsKey: string
  // Changes when the failed counts may have: runs, rows coming or going, a renamed column.
  failedKey: string
}

export interface PendingRunControl {
  column: string; rows: RunRows; estimate: RunControlEstimate | null; error: string | null; starting: boolean
}
export interface RowCost { short: string; label: string }

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback
// A row's price is read again after this long (its inputs, or answers found meanwhile, change it).
const ROW_COST_MS = 20_000
// After a start, read the failed counts again (a run that ends before the active runs list shows it).
const AFTER_START_MS = 3000

export function useColumnRunControls(a: Args) {
  const sheetId = a.activeSheet?.id ?? null
  const latest = useRef(a)
  latest.current = a
  const { failed, refresh: refreshFailed, drop: dropFailed } = useFailedRuns(sheetId, a.failedKey)

  // A run started from here: follow it live, show its header controls and placeholders.
  const started = useCallback((out: RunControlStarted) => {
    const x = latest.current
    const id = x.activeSheet?.id
    if (!id) return
    x.setupSSEConnection(out.runId, out.kind === 'ai' ? 'ai' : 'http')
    if (out.kind === 'ai') x.fetchActiveAIRuns(id); else x.fetchActiveHTTPRuns(id)
    x.reloadSheetData?.(id)
    refreshFailed(AFTER_START_MS)
  }, [refreshFailed])

  // The header's "N failed, retry": no confirm, it runs at once (an enrichment's
  // and a waterfall's run limit is sized to the rows, as an agent's rerun is).
  const retryFailed = useCallback((column: string) => {
    if (!sheetId) return
    dropFailed(column)
    runControlsAPI.start(sheetId, column, { rows: 'failed' })
      .then(out => { toast.success(`Retrying ${plural(out.rows, 'failed row')}`); started(out) })
      .catch(e => { toast.error(errorOf(e, "Couldn't retry the failed rows.")); refreshFailed(0) })
  }, [sheetId, dropFailed, refreshFailed, started])

  // A cell's play button: what its row costs, read once a while per row, then run it.
  const costs = useRef(new Map<string, { at: number; cost: Promise<RowCost> }>())
  useEffect(() => { costs.current.clear() }, [sheetId, a.runsKey])
  const rowCost = useCallback((column: string, row: number): Promise<RowCost> => {
    if (!sheetId) return Promise.resolve({ short: 'Run', label: 'Run this row' })
    const key = JSON.stringify([column, row])
    const held = costs.current.get(key)
    if (held && Date.now() - held.at < ROW_COST_MS) return held.cost
    const cost = runControlsAPI.estimate(sheetId, column, { row })
      .then(e => ({ short: rowCostShort(e), label: rowCostLabel(e) }))
      .catch(e => (e?.response?.data?.nothingToRun
        ? { short: 'Nothing to run', label: 'Nothing to run in this row' }
        : { short: 'Run', label: 'Run this row' }))
    costs.current.set(key, { at: Date.now(), cost })
    return cost
  }, [sheetId])
  const runRow = useCallback((column: string, row: number) => {
    if (!sheetId) return
    const rowGeneration = latest.current.rowGenerationRef?.current.get(sheetId)
    runControlsAPI.start(sheetId, column, { row, ...(rowGeneration !== undefined ? { rowGeneration } : {}) })
      .then(started)
      .catch(e => {
        toast.error(errorOf(e, "Couldn't run this row."))
        // Reordered elsewhere since the tab loaded it: load the rows again so the next click takes the right row.
        if (e?.response?.data?.currentGeneration !== undefined) latest.current.reloadSheetData?.(sheetId)
      })
  }, [sheetId, started])

  // The AI and HTTP API menus' runs: the estimate first, then Run.
  const [pending, setPending] = useState<PendingRunControl | null>(null)
  const seq = useRef(0)
  const ask = (column: string, rows: RunRows) => {
    if (!sheetId) return
    const id = ++seq.current
    setPending({ column, rows, estimate: null, error: null, starting: false })
    runControlsAPI.estimate(sheetId, column, { rows })
      .then(estimate => { if (seq.current === id) setPending(p => (p ? { ...p, estimate } : p)) })
      .catch(e => {
        if (seq.current !== id) return
        const nothing = e?.response?.data?.nothingToRun
        setPending(p => (p ? nothing
          ? { ...p, estimate: { ...EMPTY, column } }
          : { ...p, error: errorOf(e, "Couldn't estimate this run.") } : p))
      })
  }
  const confirm = async () => {
    const p = pending
    if (!sheetId || !p || p.starting) return
    setPending({ ...p, starting: true, error: null })
    try {
      const out = await runControlsAPI.start(sheetId, p.column, { rows: p.rows }, p.estimate?.spendLimitUsd)
      setPending(null)
      started(out)
    } catch (e) {
      setPending(cur => (cur ? { ...cur, starting: false, error: errorOf(e, "Couldn't start the run.") } : cur))
    }
  }
  const cancel = () => { seq.current++; setPending(null) }

  const cells = useMemo(() => ({ rowCost, runRow }), [rowCost, runRow])
  return { failed, retryFailed, ask, pending, confirm, cancel, cells }
}

const EMPTY: RunControlEstimate = {
  kind: 'ai', column: '', rows: 0, lowUsd: null, highUsd: null, basis: 'range', spendLimitUsd: null, reusedRows: 0,
  note: null,
}
