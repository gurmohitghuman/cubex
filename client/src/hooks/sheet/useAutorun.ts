import { useState } from 'react'
import toast from 'react-hot-toast'
import { autorunAPI, type Sheet, type SheetData } from '@/utils/api'
import type { AutorunKind, SheetAutorun } from '@/utils/api/types-autorun'
import type { AutorunTarget } from '@/components/autorun/AutorunDialog'

// Auto-run on the open sheet: what the column headers and the header chip show
// (it rides the sheet payload, so every reload refreshes it), the column's
// auto-run dialog, turning a column's auto-run off, and pausing every
// auto-run on the sheet.
// Is any column's auto-run on that spends or sends requests (the CSV import
// and the webhook drawer warn then)? A clean data, formula or lookup column's is free and sends nothing.
export const anyAutorunOn = (view?: SheetAutorun | null): boolean =>
  Object.values(view?.columns ?? {})
    .some(c => c.enabled && c.kind !== 'clean' && c.kind !== 'formula' && c.kind !== 'lookup')

export function useAutorun(a: {
  activeSheet: Sheet | null
  sheetData: SheetData | null
  silentReload: (sheetId: string) => unknown
  // A clean data, formula or lookup column has no auto-run dialog: its Edit dialog holds the switch.
  openClean?: (column: string) => void
  openFormula?: (column: string) => void
  openLookup?: (column: string) => void
}) {
  const view = a.sheetData?.data.autorun
  const [target, setTarget] = useState<(AutorunTarget & { nonce: number }) | null>(null)
  const sheetId = a.activeSheet?.id ?? null
  const refresh = () => { if (sheetId) void a.silentReload(sheetId) }
  const kindOf = (column: string): AutorunKind => {
    const type = a.sheetData?.data.columnTypes?.[column]
    if (type === 'clean' || type === 'formula' || type === 'lookup') return view?.columns[column]?.kind ?? type
    return view?.columns[column]?.kind ?? (type === 'enrich-status' ? 'enrichment' : 'http')
  }

  const open = (column: string) => {
    const kind = kindOf(column)
    if (kind === 'clean') a.openClean?.(column)
    else if (kind === 'formula') a.openFormula?.(column)
    else if (kind === 'lookup') a.openLookup?.(column)
    else setTarget({ column, kind, nonce: Date.now() })
  }
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
  return {
    view, spend: a.sheetData?.data.columnSpend, target, sheetId,
    anyOn: anyAutorunOn(view),
    open, close: () => setTarget(null), onSaved: refresh, pauseAll,
    onAction: (column: string, action: 'open' | 'off') => (action === 'off' ? void turnOff(column) : open(column)),
  }
}

export type AutorunControls = ReturnType<typeof useAutorun>
