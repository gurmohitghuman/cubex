import React from 'react'
import type { useSheetModals } from '@/hooks/sheet/useSheetModals'
import { SaveSetupModal } from './SaveSetupModal'
import { UseSetupModal } from './UseSetupModal'

// The sheet page's two setup dialogs, opened from the header's Setups menu and a column's menu.
export const SheetSetupDialogs: React.FC<{
  sheetId: string | undefined; columns: string[]; modals: ReturnType<typeof useSheetModals>
}> = ({ sheetId, columns, modals }) => {
  if (!sheetId) return null
  return (
    <>
      <SaveSetupModal isOpen={!!modals.saveSetupFor} onClose={modals.closeSaveSetup} sheetId={sheetId}
        column={modals.saveSetupFor?.column ?? null} />
      <UseSetupModal isOpen={modals.showUseSetup} onClose={() => modals.setShowUseSetup(false)} sheetId={sheetId}
        columns={columns} />
    </>
  )
}
