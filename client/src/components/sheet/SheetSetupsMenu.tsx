import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Bookmark } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface Props {
  // Save as setup with nothing ticked yet (the column menu opens it on a column).
  onSaveSetup: () => void
}

// The sheet header's Setups menu: save this sheet's filled columns as a setup,
// or open the saved ones in Settings.
export const SheetSetupsMenu: React.FC<Props> = ({ onSaveSetup }) => {
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
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onClick={onSaveSetup}>Save columns as a setup…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate('/settings/setups')}>Manage setups</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
