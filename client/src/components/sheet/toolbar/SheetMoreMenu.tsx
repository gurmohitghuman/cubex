import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BarChart3, Bookmark, BookmarkPlus, GitCompare, History, MoreHorizontal, Settings2 } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { UsageDrawer } from '@/components/usage/UsageDrawer'
import { HistoryDrawer } from '@/components/history/HistoryDrawer'
import { MenuEntry, MenuHeading, useMenuFocus } from './MenuEntry'

interface Props {
  // The sheet Usage and History read (null: none open yet: they're left out).
  sheetId: string | null
  sheetName: string
  onUseSetup: () => void
  // Save as setup with nothing ticked yet (the column menu opens it on a column).
  onSaveSetup: () => void
  onSetupVersions: () => void
}

// The sheet header's ⋯ menu: setups (use one, save one, this sheet's versions,
// manage them), what the sheet's runs cost (Usage) and its change log (History).
export const SheetMoreMenu: React.FC<Props> = ({ sheetId, sheetName, onUseSetup, onSaveSetup, onSetupVersions }) => {
  const navigate = useNavigate()
  const [drawer, setDrawer] = useState<'usage' | 'history' | null>(null)
  const focus = useMenuFocus()
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button ref={focus.trigger} className="btn-secondary flex h-8 items-center px-2" data-testid="more-menu"
            aria-label="More: setups, usage, history" title="Setups, usage and history">
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64" onCloseAutoFocus={focus.onCloseAutoFocus}>
          <MenuHeading>Setups</MenuHeading>
          <MenuEntry icon={Bookmark} label="Use a setup…" onSelect={focus.opening(onUseSetup)}
            testId="setups-menu-use" />
          <MenuEntry icon={BookmarkPlus} label="Save columns as a setup…" onSelect={focus.opening(onSaveSetup)}
            testId="setups-menu-save" />
          <MenuEntry icon={GitCompare} label="This sheet's setup versions…" onSelect={focus.opening(onSetupVersions)}
            testId="setups-menu-versions" />
          <MenuEntry icon={Settings2} label="Manage setups" onSelect={() => navigate('/settings/setups')}
            testId="setups-menu-manage" />
          {sheetId && (
            <>
              <DropdownMenuSeparator />
              <MenuEntry icon={BarChart3} label="Usage" hint="What this sheet's runs ran and cost"
                onSelect={focus.opening(() => setDrawer('usage'))} testId="sheet-usage" />
              <MenuEntry icon={History} label="History" hint="What changed on this sheet, and who"
                onSelect={focus.opening(() => setDrawer('history'))} testId="sheet-history" />
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {sheetId && (
        <>
          <UsageDrawer isOpen={drawer === 'usage'} onClose={() => setDrawer(null)} sheetId={sheetId}
            sheetName={sheetName} />
          <HistoryDrawer isOpen={drawer === 'history'} onClose={() => setDrawer(null)} sheetId={sheetId} />
        </>
      )}
    </>
  )
}
