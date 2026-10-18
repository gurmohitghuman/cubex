import React, { useState } from 'react'
import { BarChart3 } from 'lucide-react'
import { UsageDrawer } from '@/components/usage/UsageDrawer'

// The header's Usage button and the drawer it opens (what the sheet's runs cost).
export const SheetUsageButton: React.FC<{ sheetId: string | null; sheetName: string }> = ({ sheetId, sheetName }) => {
  const [open, setOpen] = useState(false)
  if (!sheetId) return null
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title="What this sheet's runs ran and cost"
        className="btn-secondary flex items-center space-x-1" data-testid="sheet-usage">
        <BarChart3 className="h-3 w-3" />
        <span>Usage</span>
      </button>
      <UsageDrawer isOpen={open} onClose={() => setOpen(false)} sheetId={sheetId} sheetName={sheetName} />
    </>
  )
}
