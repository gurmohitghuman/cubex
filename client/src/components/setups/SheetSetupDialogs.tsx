import React from 'react'
import type { useSheetModals } from '@/hooks/sheet/useSheetModals'
import { SaveSetupModal } from './SaveSetupModal'
import { UseSetupModal } from './UseSetupModal'
import { SetupVersionsDialog } from '@/components/setup-versions/SetupVersionsDialog'
import { RunColumnsModal } from '@/components/column-runs/RunColumnsModal'
import type { WhereItem } from '@/utils/api/views'

// The sheet page's setup dialogs, opened from the header's Setups menu, a column's menu and a sheet tab's
// menu (setup versions; onRestored reloads the sheet a restore changed), and Run columns (the Data menu's;
// filter: the sheet's filter, or null when none is on).
export const SheetSetupDialogs: React.FC<{
  sheetId: string | undefined; sheetName: string; columns: string[]; modals: ReturnType<typeof useSheetModals>
  onRestored: (sheetId: string) => void; filter: WhereItem[] | null
}> = ({ sheetId, sheetName, columns, modals, onRestored, filter }) => {
  if (!sheetId) return null
  return (
    <>
      <SaveSetupModal isOpen={!!modals.saveSetupFor} onClose={modals.closeSaveSetup} sheetId={sheetId}
        column={modals.saveSetupFor?.column ?? null} />
      <UseSetupModal isOpen={modals.showUseSetup} onClose={() => modals.setShowUseSetup(false)} sheetId={sheetId}
        columns={columns} />
      <RunColumnsModal isOpen={modals.showRunColumns} onClose={() => modals.setShowRunColumns(false)}
        sheetId={sheetId} filter={filter} />
      <SetupVersionsDialog sheetId={modals.versionsFor} sheetName={sheetName} onClose={modals.closeVersions}
        onRestored={onRestored} />
    </>
  )
}
