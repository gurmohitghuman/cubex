// The words of "Undo last run" (pure): the confirm's message and the result.
import type { UndoView } from '@/utils/api/run-undo'
import { plural } from './utils'
import { UNDO_KEEP_DAYS } from './constants'

export const UNDO_TITLE = 'Undo last run'

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function undoConfirmMessage(v: UndoView | null, column: string): string {
  if (!v) {
    return `"${column}" has no run that can be undone. A run can be undone once, for ${UNDO_KEEP_DAYS} days after `
      + 'it starts.'
  }
  if (!v.can_undo) return v.reason ?? "This run can't be undone now."
  return `Undo the run of "${v.column ?? column}" from ${when(v.started_at)}? The cells it filled in `
    + `${plural(v.rows, 'row')} go back to what they held before it. Cells changed since it ran stay as they are. `
    + 'Nothing runs again and nothing is billed, but its results are gone: running it again bills again.'
}

// The toast once it is undone.
export function undoneMessage(v: UndoView): string {
  const parts = [`Undone: ${plural(v.restored, 'cell')} back as before the run.`]
  const were = (n: number) => (n === 1 ? 'was' : 'were')
  if (v.skipped) parts.push(`${plural(v.skipped, 'cell')} changed since ${were(v.skipped)} left as is.`)
  if (v.gone) parts.push(`${plural(v.gone, 'cell')} ${were(v.gone)} in deleted rows or columns.`)
  return parts.join(' ')
}
