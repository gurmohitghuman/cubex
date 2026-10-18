import React from 'react'
import { WebhookDrawer } from './WebhookDrawer'
import { WebhookPayloadModal } from './WebhookPayloadModal'
import type { AutoDedupeView } from '@/utils/api'

// The two webhook overlays SheetPage renders (the management drawer + the
// row-level raw-payload modal), grouped so SheetPage's JSX stays lean. Pure
// presentational pass-through — all state lives in SheetPage.
export function SheetWebhookOverlays({
  drawerOpen, onCloseDrawer, sheetId, rowCount, onColumnsChanged, onCreateNewTable,
  payloadRowIndex, onClosePayload, autorunOn, autoDedupe, onAutoDedupe,
}: {
  // Auto-run is on in this sheet: every delivered row can spend (the drawer says so).
  autorunOn?: boolean
  drawerOpen: boolean
  onCloseDrawer: () => void
  sheetId: string | null
  rowCount: number
  onColumnsChanged: () => void
  onCreateNewTable?: () => void
  payloadRowIndex: number | null
  onClosePayload: () => void
  // The sheet's auto-dedupe (null: off), and opening its settings.
  autoDedupe?: AutoDedupeView | null
  onAutoDedupe?: () => void
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
        autorunOn={autorunOn}
        autoDedupe={autoDedupe}
        onAutoDedupe={onAutoDedupe}
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
