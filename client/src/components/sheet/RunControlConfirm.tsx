import React from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { CONFIRM_TITLE, confirmMessage } from '@/lib/run-controls-copy'
import type { PendingRunControl } from '@/hooks/sheet/useColumnRunControls'

interface Props { pending: PendingRunControl | null; onConfirm: () => void; onCancel: () => void }

// The confirm before an AI or HTTP API column's run from its menu: the rows it
// takes and what they could cost, read first (nothing starts until Run). With
// no rows to run it only says so.
export const RunControlConfirm: React.FC<Props> = ({ pending, onConfirm, onCancel }) => {
  const e = pending?.estimate ?? null
  const error = pending?.error ?? null
  const closeOnly = e?.rows === 0 || (!!error && !e)
  const message = !e ? error ?? 'Counting the rows and estimating the cost…'
    : `${error ? `${error} ` : ''}${confirmMessage(pending!.rows, e)}`
  return (
    <ConfirmDialog
      isOpen={!!pending}
      title={pending ? CONFIRM_TITLE[pending.rows] : ''}
      message={message}
      confirmText={closeOnly ? 'Close' : 'Run'}
      // While the figures load, Cancel still works and Run waits for them.
      isLoading={!!pending?.starting}
      confirmDisabled={!!pending && !e && !error}
      hideCancel={closeOnly}
      onConfirm={closeOnly ? onCancel : onConfirm}
      onCancel={onCancel}
    />
  )
}
