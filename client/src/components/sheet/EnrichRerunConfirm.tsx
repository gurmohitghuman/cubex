import React from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { RERUN_TITLE, rerunMessage } from '@/components/enrich-modal/rerun-copy'
import type { PendingRerun } from '@/hooks/sheet/useEnrichColumnActions'

interface Props {
  pending: PendingRerun | null
  onConfirm: () => void
  onCancel: () => void
}

// The confirm before a column menu's enrichment run: the rows it takes and
// what they could cost, read from the server first (nothing starts until Run).
// With no rows to run it only says so.
export const EnrichRerunConfirm: React.FC<Props> = ({ pending, onConfirm, onCancel }) => {
  const e = pending?.estimate ?? null
  const error = pending?.error ?? null
  // Nothing to run, or no estimate to run on: the only way on is Close.
  const closeOnly = e?.rows === 0 || (!!error && !e)
  const message = !e ? error ?? 'Counting the rows and estimating the cost…'
    : `${error ? `${error} ` : ''}${rerunMessage(pending!.action, e)}`
  return (
    <ConfirmDialog
      isOpen={!!pending}
      title={pending ? RERUN_TITLE[pending.action] : ''}
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
