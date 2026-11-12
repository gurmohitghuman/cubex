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
  rerun: 'Replaced by a rerun',
  sheet: 'Sheet deleted',
  table: 'Table deleted',
  column: 'Column deleted',
}

export const howText = (how: TrashHow): string => HOW[how] ?? 'Deleted'

export function titleOf(e: TrashEntry): string {
  if (e.kind === 'table') return `Table "${e.table_name}"`
  if (e.kind === 'sheet') return `Sheet "${e.sheet_name}"`
  if (e.kind === 'column') return `Column "${e.column ?? ''}" from "${e.sheet_name}"`
  return `${plural(e.rows, 'row')} from "${e.sheet_name}"`
}

export function placeOf(e: TrashEntry): string {
  if (e.kind === 'table') return plural(e.rows, 'row')
  if (e.kind === 'sheet') return `In "${e.table_name}" · ${plural(e.rows, 'row')}`
  if (e.kind === 'column') return `In "${e.table_name}" · ${plural(e.cells ?? e.rows, 'cell')} · ${e.column_kind ?? ''}`
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
  if (got.kind === 'column') return columnRestoredText(got)
  const where = got.place === 'old' ? 'to their old places' : 'to the end of the sheet'
  const rows = plural(got.rows ?? 0, 'row')
  if (got.state === 'restoring') return `Restoring ${rows}${e?.sheet_name ? ` to "${e.sheet_name}"` : ''}…`
  const added = got.columns_added?.length ? ` Columns added back: ${got.columns_added.join(', ')}.` : ''
  const lost = got.columns_left_out?.length
    ? ` Left out (no room for more columns): ${got.columns_left_out.join(', ')}.` : ''
  return `Restored ${rows} ${where}${e?.sheet_name ? ` in "${e.sheet_name}"` : ''}.${added}${lost}`
}

type Restored = NonNullable<TrashRestoreResult['restored']>

// A column: its name (and why it changed), its cells, and how many references didn't come back.
function columnRestoredText(got: Restored): string {
  const as = got.renamed ? ` as "${got.name}" ("${got.old_name}" was taken)` : ''
  if (got.state === 'restoring') return `Restoring the column "${got.old_name}"${as}…`
  const skipped = got.cells_skipped ? ` ${plural(got.cells_skipped, 'cell')} left out: their rows are gone.` : ''
  const kept = got.cells_kept
    ? ` ${plural(got.cells_kept, 'cell')} stayed in the trash: their rows hold a value there now.` : ''
  const dropped = got.references_dropped ?? []
  const named = dropped.slice(0, 3).map(r => r.where).join(', ')
  const more = dropped.length > 3 ? ` and ${dropped.length - 3} more` : ''
  const refs = dropped.length ? ` Not brought back, set up again if needed: ${named}${more}.` : ''
  return `Restored the column "${got.old_name}"${as}, ${plural(got.cells_restored ?? 0, 'cell')} back.${skipped}${kept}`
    + refs
}
