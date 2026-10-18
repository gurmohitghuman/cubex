import React, { useState } from 'react'
import { History } from 'lucide-react'
import { HistoryDrawer } from '@/components/history/HistoryDrawer'

// The header's History button and the drawer it opens (the sheet's change log).
export const SheetHistoryButton: React.FC<{ sheetId: string | null }> = ({ sheetId }) => {
  const [open, setOpen] = useState(false)
  if (!sheetId) return null
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title="History: what changed on this sheet, and who"
        aria-label="History" className="btn-secondary flex items-center" data-testid="sheet-history">
        <History className="h-3 w-3" />
      </button>
      <HistoryDrawer isOpen={open} onClose={() => setOpen(false)} sheetId={sheetId} />
    </>
  )
}
