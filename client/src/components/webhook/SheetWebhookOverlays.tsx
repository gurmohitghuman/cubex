import React from 'react'
import { WebhookDrawer } from './WebhookDrawer'
import { WebhookPayloadModal } from './WebhookPayloadModal'

// The two webhook overlays SheetPage renders (the management drawer + the
// row-level raw-payload modal), grouped so SheetPage's JSX stays lean. Pure
// presentational pass-through — all state lives in SheetPage.
export function SheetWebhookOverlays({
  drawerOpen, onCloseDrawer, sheetId, rowCount, onColumnsChanged, onCreateNewTable,
  payloadRowIndex, onClosePayload,
}: {
  drawerOpen: boolean
  onCloseDrawer: () => void
  sheetId: string | null
  rowCount: number
  onColumnsChanged: () => void
  onCreateNewTable?: () => void
  payloadRowIndex: number | null
  onClosePayload: () => void
}) {
  return (
    <>
      <WebhookDrawer
        isOpen={drawerOpen}
        onClose={onCloseDrawer}
        sheetId={sheetId}
        rowCount={rowCount}
        onColumnsChanged={onColumnsChanged}
        onCreateNewTable={onCreateNewTable}
      />
      <WebhookPayloadModal
        isOpen={payloadRowIndex != null}
        onClose={onClosePayload}
        sheetId={sheetId}
        rowIndex={payloadRowIndex}
      />
    </>
  )
}
