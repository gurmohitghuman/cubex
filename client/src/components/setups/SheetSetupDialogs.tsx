import React from 'react'
import type { useSheetModals } from '@/hooks/sheet/useSheetModals'
import { SaveSetupModal } from './SaveSetupModal'
import { UseSetupModal } from './UseSetupModal'
import { SetupVersionsDialog } from '@/components/setup-versions/SetupVersionsDialog'

// The sheet page's setup dialogs, opened from the header's Setups menu, a column's menu and a sheet tab's
// menu (setup versions; onRestored reloads the sheet a restore changed).
export const SheetSetupDialogs: React.FC<{
  sheetId: string | undefined; sheetName: string; columns: string[]; modals: ReturnType<typeof useSheetModals>
  onRestored: (sheetId: string) => void
}> = ({ sheetId, sheetName, columns, modals, onRestored }) => {
  if (!sheetId) return null
  return (
    <>
      <SaveSetupModal isOpen={!!modals.saveSetupFor} onClose={modals.closeSaveSetup} sheetId={sheetId}
        column={modals.saveSetupFor?.column ?? null} />
      <UseSetupModal isOpen={modals.showUseSetup} onClose={() => modals.setShowUseSetup(false)} sheetId={sheetId}
        columns={columns} />
      <SetupVersionsDialog sheetId={modals.versionsFor} sheetName={sheetName} onClose={modals.closeVersions}
        onRestored={onRestored} />
    </>
  )
}
