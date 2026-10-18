import toast from 'react-hot-toast'
import { toastDeleted } from '@/components/trash/trashToast'
import { plural } from '@/lib/utils'
import type { GridAutoDedupe, ImportAutoDedupe } from '@/utils/api'

// After a grid edit gave a row a key another row has: what went to the trash,
// with "Restore" for just those rows (a restore isn't checked).
export function toastAutoDeduped(d: GridAutoDedupe, onRestored: () => void): void {
  const n = d.removed.length
  if (n === 0) {
    if (d.waiting > 0) {
      toast(`Auto-dedupe will check ${plural(d.waiting, 'row')} once the sheet is free.`, { id: 'auto-dedupe' })
    }
    return
  }
  const keeps = `It keeps the ${d.keep} row of each ${d.column}.`
  toastDeleted(d.trashId === null
    ? `Auto-dedupe deleted ${plural(n, 'row')} with a repeated ${d.column} for good (Settings keeps deleted `
      + `items 0 days). ${keeps}`
    : `Auto-dedupe sent ${plural(n, 'row')} with a repeated ${d.column} to the trash. ${keeps}`,
  d.trashId, { id: 'auto-dedupe', seqs: d.seqs, onRestored })
}

// What a CSV import's toast adds about the rows auto-dedupe didn't keep.
export function importDedupeText(d: ImportAutoDedupe | null | undefined): string {
  if (!d) return ''
  const where = d.trashId === null ? 'were deleted for good' : 'went to the trash'
  const gone = d.removed > 0 ? ` ${plural(d.removed, 'row')} ${where}: auto-dedupe keeps one row per ${d.column}.` : ''
  return gone + (d.left ? ' Auto-dedupe is still checking the rest.' : '')
}
