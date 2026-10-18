import React from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { formatCost } from '@/components/ai-modal/format'
import type { PendingWaterfallRun, WaterfallRerunAction } from '@/hooks/sheet/useWaterfallColumn'

interface Props { pending: PendingWaterfallRun | null; onConfirm: () => void; onCancel: () => void }

const TITLE: Record<WaterfallRerunAction, string> = {
  stale: 'Run empty or out-of-date rows', failed: 'Retry the failed rows', selected: 'Run the selected rows',
  all: 'Force run all rows',
}
const money = (v: number) => (v === 0 ? '$0' : formatCost(v))

// The confirm before a waterfall column's run from its menu: the rows it takes
// and what they could cost, read first (nothing starts until Run).
export const WaterfallRerunConfirm: React.FC<Props> = ({ pending, onConfirm, onCancel }) => {
  const e = pending?.estimate ?? null
  const error = pending?.error ?? null
  const closeOnly = e?.rows === 0 || (!!error && !e)
  const message = !e ? error ?? 'Counting the rows and estimating the cost…'
    : e.rows === 0
      ? (pending?.action === 'stale' ? 'No row here is empty or out of date.' : 'No rows here to run.')
      : `${error ? `${error} ` : ''}${e.rows.toLocaleString()} rows: about ${money(e.total.average_usd)}, at most `
        + `${money(e.total.max_usd)}. Enrichment steps bill your treg balance, AI steps OpenRouter.`
  return (
    <ConfirmDialog isOpen={!!pending} title={pending ? TITLE[pending.action] : ''} message={message}
      confirmText={closeOnly ? 'Close' : 'Run'} isLoading={!!pending?.starting}
      confirmDisabled={!!pending && !e && !error} hideCancel={closeOnly}
      onConfirm={closeOnly ? onCancel : onConfirm} onCancel={onCancel} />
  )
}
