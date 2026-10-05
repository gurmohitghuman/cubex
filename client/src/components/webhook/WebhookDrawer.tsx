import React, { useState } from 'react'
import { Loader2, Inbox } from 'lucide-react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Drawer, DrawerHeader, DrawerBody } from '@/components/Drawer'
import { useWebhook } from './useWebhook'
import { WebhookStatus } from './WebhookStatus'
import { WebhookEndpoint } from './WebhookEndpoint'
import { WebhookMapping } from './WebhookMapping'
import { WebhookDeliveries } from './WebhookDeliveries'

// Sheet-scoped webhook drawer (slide-over from the right). A webhook is a
// persistent always-on source the user returns to — so this is a drawer with
// Status · Endpoint · Samples/Mappings · Deliveries, not a fire-and-forget modal.
// `onColumnsChanged` tells the parent to reload the sheet when the webhook
// creates/removes columns (marker + mapped columns).
export function WebhookDrawer({
  isOpen, onClose, sheetId, rowCount, onColumnsChanged, onCreateNewTable,
}: {
  isOpen: boolean
  onClose: () => void
  sheetId: string | null
  // Current row count of the sheet — drives the "events append below N rows,
  // sharing the cap" warning shown before creating a webhook on a non-empty sheet.
  rowCount: number
  onColumnsChanged: () => void
  // Provided ONLY when the user can still create another table (under the table
  // cap). Lets them route the webhook to a fresh table instead of mixing it into
  // a hand-curated sheet. Absent → the option isn't shown.
  onCreateNewTable?: () => void
}) {
  const wh = useWebhook(sheetId, isOpen)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Whenever columns may have changed (create / map / delete), nudge the parent
  // to reload the grid so the new columns + marker show up.
  const reloadParent = onColumnsChanged

  const handleCreate = async () => { await wh.create(); reloadParent() }
  const handleAddMapping = async (p: string, c: string) => { await wh.addMapping(p, c); reloadParent() }
  const handleDeleteMapping = async (id: string) => { await wh.deleteMapping(id); reloadParent() }
  const handleRemoveConfirmed = async () => {
    setConfirmDelete(false)
    await wh.remove()
    reloadParent()
  }

  return (
    <>
    <Drawer isOpen={isOpen} onClose={onClose}>
      <DrawerHeader icon={<Inbox className="h-4 w-4 text-cube-black" />} title="Webhook" onClose={onClose} />
      <DrawerBody>
        {wh.loading ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : !wh.source ? (
          <EmptyState
            onCreate={handleCreate} busy={wh.busy}
            rowCount={rowCount} onCreateNewTable={onCreateNewTable}
          />
        ) : (
          <>
            <WebhookStatus source={wh.source} onToggle={wh.setEnabled} onDelete={() => setConfirmDelete(true)} busy={wh.busy} />
            <WebhookEndpoint source={wh.source} onRotate={wh.rotate} rotating={wh.busy} />
            <WebhookMapping
              deliveries={wh.deliveries} mappings={wh.mappings}
              onPick={handleAddMapping} onDeleteMapping={handleDeleteMapping}
            />
            <WebhookDeliveries deliveries={wh.deliveries} />
          </>
        )}
      </DrawerBody>
    </Drawer>

    <ConfirmDialog
      isOpen={confirmDelete}
      title="Delete this webhook?"
      message="The URL stops working immediately and the marker column is freed. Mapped columns and their data stay."
      confirmText="Delete webhook"
      cancelText="Cancel"
      isDestructive
      isLoading={wh.busy}
      onConfirm={handleRemoveConfirmed}
      onCancel={() => setConfirmDelete(false)}
    />
    </>
  )
}

function EmptyState({
  onCreate, busy, rowCount, onCreateNewTable,
}: {
  onCreate: () => void
  busy: boolean
  rowCount: number
  onCreateNewTable?: () => void
}) {
  const hasData = rowCount > 0
  return (
    <div className="space-y-4">
      <div className="rounded border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600 space-y-2">
        <p className="font-medium text-gray-800">Turn this sheet into a webhook receiver.</p>
        <p>POST JSON to a secret URL → a new row appears in this sheet. Pick which fields
          become columns from a real event.</p>
        <p className="text-xs text-gray-500">
          Each event creates a <strong>new row below your current data</strong>. Existing
          rows aren't changed.
        </p>
      </div>

      {hasData && (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 space-y-1">
          <p>
            This sheet already has <strong>{rowCount.toLocaleString()}</strong> row
            {rowCount === 1 ? '' : 's'}. Webhook events append below them.
          </p>
          {onCreateNewTable && (
            <p>Prefer to keep them separate? Start the webhook in a fresh table instead.</p>
          )}
        </div>
      )}

      <div className="space-y-2">
        <button type="button" onClick={onCreate} disabled={busy} className="btn-orange w-full disabled:opacity-50">
          {busy ? 'Creating…' : hasData ? 'Create webhook on this sheet' : 'Create webhook'}
        </button>
        {hasData && onCreateNewTable && (
          <button type="button" onClick={onCreateNewTable} disabled={busy} className="btn-secondary w-full disabled:opacity-50">
            Create a new table for the webhook
          </button>
        )}
      </div>
    </div>
  )
}

