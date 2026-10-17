import React from 'react'
import { Check, ChevronDown, Layers } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { SheetViews } from '@/hooks/sheet/useSheetViews'
import type { ViewDialogState } from './ViewDialog'

interface Props {
  views: SheetViews
  // Whether the sheet has AI, HTTP API or enrichment columns (the ready-made views read them).
  hasRunColumns: boolean
  openDialog: (state: ViewDialogState) => void
}

// The view switcher: every saved view, new view, rename, delete, and the
// ready-made views (made only when picked).
export const ViewMenu: React.FC<Props> = ({ views, hasRunColumns, openDialog }) => {
  const { active } = views
  const noRuns = hasRunColumns ? undefined : 'Add an AI, HTTP API or enrichment column first'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="btn-secondary !py-1 flex items-center gap-1.5 max-w-[16rem]" data-testid="view-menu"
          title={active?.description ?? 'Switch views: each one keeps its own filters and hidden columns'}>
          <Layers className="h-3 w-3 flex-shrink-0" />
          <span className="truncate">{active?.name ?? 'Default'}</span>
          <ChevronDown className="h-3 w-3 flex-shrink-0 text-gray-500" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-xs text-gray-500">Views</DropdownMenuLabel>
        <div className="max-h-72 overflow-y-auto">
          {views.views.map(v => (
            <DropdownMenuItem key={v.id} onClick={() => { if (!v.active) void views.switchTo(v.id) }}
              className="items-start gap-2" data-testid="view-option">
              <Check className={`h-4 w-4 mt-0.5 flex-shrink-0 ${v.active ? '' : 'invisible'}`} />
              <span className="min-w-0">
                <span className="block truncate">{v.name}</span>
                {v.description && <span className="block text-xs text-gray-500 truncate">{v.description}</span>}
              </span>
            </DropdownMenuItem>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openDialog({ mode: 'new' })}>New view…</DropdownMenuItem>
        {active && (
          <DropdownMenuItem onClick={() => openDialog({ mode: 'edit', view: active })}>
            Rename or describe…
          </DropdownMenuItem>
        )}
        {active && !active.is_default && (
          <DropdownMenuItem onClick={() => openDialog({ mode: 'delete', view: active })}
            className="text-red-600 focus:text-red-600">Delete view</DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs text-gray-500">Ready-made views</DropdownMenuLabel>
        <DropdownMenuItem disabled={!hasRunColumns} title={noRuns} onClick={() => void views.starter('errors')}>
          Rows with errors
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!hasRunColumns} title={noRuns} onClick={() => void views.starter('filled')}>
          Fully filled rows
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
