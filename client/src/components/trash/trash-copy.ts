import { plural } from '@/lib/utils'
import type { TrashEntry, TrashHow, TrashRestoreResult } from '@/utils/api'

// The Trash page's words: what an item is, how it went, how long it stays.
const HOW: Record<TrashHow, string> = {
  grid: 'Deleted in the sheet',
  api: 'Deleted with delete_rows',
  duplicates: 'Removed as duplicates',
  auto_dedupe: 'Removed by auto-dedupe',
  import: 'Replaced by a CSV import',
  transfer: 'Moved to another sheet',
  sheet: 'Sheet deleted',
  table: 'Table deleted',
}

export const howText = (how: TrashHow): string => HOW[how] ?? 'Deleted'

export function titleOf(e: TrashEntry): string {
  if (e.kind === 'table') return `Table "${e.table_name}"`
  if (e.kind === 'sheet') return `Sheet "${e.sheet_name}"`
  return `${plural(e.rows, 'row')} from "${e.sheet_name}"`
}

export function placeOf(e: TrashEntry): string {
  if (e.kind === 'table') return plural(e.rows, 'row')
  if (e.kind === 'sheet') return `In "${e.table_name}" · ${plural(e.rows, 'row')}`
  return `In "${e.table_name}"`
}

export const whenText = (iso: string): string =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

// "29 days left", "Goes today": until it is deleted for good.
export function leftText(e: TrashEntry): string {
  const ms = Date.parse(e.expires_at) - Date.now()
  if (ms <= 0) return 'Goes soon'
  const days = Math.floor(ms / 86_400_000)
  return days === 0 ? 'Goes today' : `${plural(days, 'day')} left`
}

export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

// What a restore did, in one line for a toast.
export function restoredText(r: TrashRestoreResult, e?: TrashEntry): string {
  const got = r.restored
  if (!got) return r.error ?? "Couldn't restore it"
  if (got.kind === 'table') return `Restored the table "${got.name}"${got.renamed ? ' (its name was taken)' : ''}`
  if (got.kind === 'sheet') return `Restored the sheet "${got.name}"${got.renamed ? ' (its name was taken)' : ''}`
  const where = got.place === 'old' ? 'to their old places' : 'to the end of the sheet'
  const rows = plural(got.rows ?? 0, 'row')
  if (got.state === 'restoring') return `Restoring ${rows}${e?.sheet_name ? ` to "${e.sheet_name}"` : ''}…`
  const added = got.columns_added?.length ? ` Columns added back: ${got.columns_added.join(', ')}.` : ''
  const lost = got.columns_left_out?.length
    ? ` Left out (no room for more columns): ${got.columns_left_out.join(', ')}.` : ''
  return `Restored ${rows} ${where}${e?.sheet_name ? ` in "${e.sheet_name}"` : ''}.${added}${lost}`
}
