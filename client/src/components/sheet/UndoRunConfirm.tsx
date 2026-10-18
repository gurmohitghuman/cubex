import React from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { UNDO_TITLE, undoConfirmMessage } from '@/lib/run-undo-copy'
import type { PendingUndo } from '@/hooks/sheet/useRunUndo'

interface Props { pending: PendingUndo | null; onConfirm: () => void; onCancel: () => void }

// The confirm before "Undo last run": which run, from when, on how many rows,
// read first (nothing changes until Undo run). With nothing to undo, or a run
// that can't be undone now, it only says why.
export const UndoRunConfirm: React.FC<Props> = ({ pending, onConfirm, onCancel }) => {
  const closeOnly = !!pending && !pending.loading && !pending.view?.can_undo
  const error = pending?.error ?? null
  const message = !pending ? '' : pending.loading ? "Finding the column's last run…"
    : `${error ? `${error} ` : ''}${undoConfirmMessage(pending.view, pending.column)}`
  return (
    <ConfirmDialog
      isOpen={!!pending}
      title={UNDO_TITLE}
      message={message}
      confirmText={closeOnly ? 'Close' : 'Undo run'}
      isDestructive={!closeOnly}
      isLoading={!!pending?.working}
      confirmDisabled={!!pending?.loading}
      hideCancel={closeOnly}
      onConfirm={closeOnly ? onCancel : onConfirm}
      onCancel={onCancel}
    />
  )
}
