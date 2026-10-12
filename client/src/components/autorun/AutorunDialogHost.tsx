import React from 'react'
import type { AutorunControls } from '@/hooks/sheet/useAutorun'
import { AutorunDialog } from './AutorunDialog'

// The column's auto-run dialog, mounted afresh on each open.
export const AutorunDialogHost: React.FC<{ autorun: AutorunControls }> = ({ autorun }) => {
  const t = autorun.target
  if (!t || !autorun.sheetId) return null
  return (
    <AutorunDialog key={`${t.column}:${t.nonce}`} target={t} sheetId={autorun.sheetId}
      current={autorun.view?.columns[t.column]} hasWebhook={!!autorun.view?.hasWebhook}
      onClose={autorun.close} onSaved={autorun.onSaved} />
  )
}
