import { useState } from 'react'
import toast from 'react-hot-toast'
import { autorunAPI, type Sheet, type SheetData } from '@/utils/api'
import type { SheetAutorun } from '@/utils/api/types-autorun'
import type { AutorunTarget } from '@/components/autorun/AutorunDialog'

// Auto-run on the open sheet: what the column headers and the header chip show
// (it rides the sheet payload, so every reload refreshes it), the column's
// auto-run dialog, turning a column's auto-run off, and pausing every
// auto-run on the sheet.
// Is any column's auto-run on (the CSV import and the webhook drawer warn then)?
export const anyAutorunOn = (view?: SheetAutorun | null): boolean =>
  Object.values(view?.columns ?? {}).some(c => c.enabled)

export function useAutorun(a: {
  activeSheet: Sheet | null
  sheetData: SheetData | null
  silentReload: (sheetId: string) => unknown
}) {
  const view = a.sheetData?.data.autorun
  const [target, setTarget] = useState<(AutorunTarget & { nonce: number }) | null>(null)
  const sheetId = a.activeSheet?.id ?? null
  const refresh = () => { if (sheetId) void a.silentReload(sheetId) }
  const kindOf = (column: string): AutorunTarget['kind'] => view?.columns[column]?.kind
    ?? (a.sheetData?.data.columnTypes?.[column] === 'enrich-status' ? 'enrichment' : 'http')

  const open = (column: string) => setTarget({ column, kind: kindOf(column), nonce: Date.now() })
  const turnOff = async (column: string) => {
    if (!sheetId) return
    try { await autorunAPI.save(sheetId, { column, enabled: false }); refresh() }
    catch (e: any) { toast.error(e?.response?.data?.error || "Couldn't turn off auto-run.") }
  }
  const pauseAll = async (paused: boolean) => {
    if (!sheetId) return
    try { await autorunAPI.pause(sheetId, paused); refresh() }
    catch (e: any) { toast.error(e?.response?.data?.error || "Couldn't change auto-run.") }
  }
  const types = a.sheetData?.data.columnTypes ?? {}
  return {
    view, spend: a.sheetData?.data.columnSpend, target, sheetId,
    anyOn: anyAutorunOn(view),
    // "Only run if" can't read the column itself or the webhook's marker column.
    conditionColumns: (column: string, all: string[]) =>
      all.filter(c => c !== column && types[c] !== 'webhook-source'),
    open, close: () => setTarget(null), onSaved: refresh, pauseAll,
    onAction: (column: string, action: 'open' | 'off') => (action === 'off' ? void turnOff(column) : open(column)),
  }
}

export type AutorunControls = ReturnType<typeof useAutorun>
