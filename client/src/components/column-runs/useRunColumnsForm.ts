import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { columnRunsAPI, type ColumnRunBody, type ColumnRunMode, type RunColumnKind } from '@/utils/api/column-runs'
import type { WhereItem } from '@/utils/api/views'
import { usePreviewRead } from '@/hooks/useTypedReads'
import { setupRunsChanged } from '@/lib/setup-runs-signal'
import { MAX_COLUMN_RUN_COLUMNS } from '@/lib/constants'

const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback

// The Run columns dialog's state: the sheet's run columns (every one ticked to start with), which rows
// (empty or out of date unless changed), only the rows in the current filter (on when the sheet has one),
// an optional most to spend, and the price of all that, asked again on every change; then the start.
// filter: the sheet's filter (shown in words; the server reads its own copy), or null when it has none.
export function useRunColumnsForm(p: {
  sheetId: string; open: boolean; filter: WhereItem[] | null; onStarted: () => void
}) {
  const { sheetId, open, filter, onStarted } = p
  const [columns, setColumns] = useState<Array<{ column: string; kind: RunColumnKind }> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [mode, setMode] = useState<ColumnRunMode>('empty_or_out_of_date')
  const [inFilter, setInFilter] = useState(false)
  const [maxCost, setMaxCost] = useState('')
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    if (!open) return
    setColumns(null); setLoadError(null); setMode('empty_or_out_of_date'); setMaxCost(''); setInFilter(!!filter)
    columnRunsAPI.columns(sheetId).then(list => {
      setColumns(list)
      setPicked(list.slice(0, MAX_COLUMN_RUN_COLUMNS).map(c => c.column))
    }).catch(e => setLoadError(errorOf(e, "Couldn't read this sheet's columns.")))
  }, [open, sheetId]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (column: string) => setPicked(prev => (prev.includes(column) ? prev.filter(c => c !== column)
    : prev.length >= MAX_COLUMN_RUN_COLUMNS ? prev : [...prev, column]))

  const cost = Number(maxCost)
  const costOk = maxCost.trim() === '' || (Number.isFinite(cost) && cost > 0)
  const body = useMemo((): Omit<ColumnRunBody, 'estimateOnly'> | null => {
    if (!open || !columns || picked.length === 0 || !costOk) return null
    return {
      columns: columns.map(c => c.column).filter(c => picked.includes(c)), mode,
      ...(inFilter && filter ? { inFilter: true } : {}),
      ...(maxCost.trim() ? { maxCostUsd: cost } : {}),
    }
  }, [open, columns, picked, mode, inFilter, filter, maxCost, cost, costOk])
  const estimate = usePreviewRead(sheetId, body, async (id, b, signal) => {
    const out = await columnRunsAPI.run(id, { ...b, estimateOnly: true }, signal)
    if (!('estimate' in out)) throw new Error('It started instead of pricing.')
    return out.estimate
  }, "Couldn't price it.")

  const result = estimate.result
  const nothing = !!result && result.columns.every(c => c.rows === 0)
  const canStart = !!body && !!result && !estimate.loading && !estimate.error && !nothing && !result.over_ceiling
    && !starting
  const start = async () => {
    if (!body || !canStart) return
    setStarting(true)
    try {
      await columnRunsAPI.run(sheetId, { ...body, estimateOnly: false })
      toast.success(body.columns.length === 1 ? 'Started.'
        : 'Started. A column that reads another one runs after it; the header shows how far it is.')
      setupRunsChanged(sheetId)
      onStarted()
    } catch (e) {
      toast.error(errorOf(e, "Couldn't start the run."))
    } finally {
      setStarting(false)
    }
  }

  return {
    columns, loadError, picked, toggle, mode, setMode, inFilter, setInFilter, maxCost, setMaxCost, costOk,
    estimate, nothing, canStart, starting, start,
  }
}
export type RunColumnsForm = ReturnType<typeof useRunColumnsForm>
