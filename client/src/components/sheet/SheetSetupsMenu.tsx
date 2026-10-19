import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Bookmark } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface Props {
  onUseSetup: () => void
  // Save as setup with nothing ticked yet (the column menu opens it on a column).
  onSaveSetup: () => void
  // This sheet's setup versions (components/setup-versions/).
  onSetupVersions: () => void
}

// The sheet header's Setups menu: use a saved setup on this sheet, save this
// sheet's filled columns as one, this sheet's setup versions, or open the saved ones in Settings.
export const SheetSetupsMenu: React.FC<Props> = ({ onUseSetup, onSaveSetup, onSetupVersions }) => {
  const navigate = useNavigate()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* Icon only on narrower screens, where the header's buttons would otherwise wrap. */}
        <button className="btn-secondary flex items-center space-x-1" data-testid="setups-menu" aria-label="Setups"
          title="Setups: save a chain of filled columns, and build it again on another sheet">
          <Bookmark className="h-3 w-3" />
          <span className="hidden min-[1440px]:inline">Setups</span>
        </button>
      </DropdownMenuTrigger>
      {/* No focus back to the trigger on close: a dialog an item opens takes it. */}
      <DropdownMenuContent align="end" className="w-60" onCloseAutoFocus={e => e.preventDefault()}>
        <DropdownMenuItem onClick={onUseSetup}>Use a setup…</DropdownMenuItem>
        <DropdownMenuItem onClick={onSaveSetup}>Save columns as a setup…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate('/settings/setups')}>Manage setups</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onSetupVersions} data-testid="setups-menu-versions">
          This sheet's setup versions…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
