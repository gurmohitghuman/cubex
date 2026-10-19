import React from 'react'
import { ChevronDown, CopyMinus, Database, Download, Import, Inbox, Loader2 } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { MenuEntry, useMenuFocus } from './MenuEntry'

// Export the view showing, or every row and column.
export type ExportScope = 'view' | 'sheet'

interface Props {
  hasRows: boolean
  columnCount: number
  isExporting: boolean
  // The view showing narrows the sheet (filters or hidden columns): export offers it apart from the whole sheet.
  viewNarrows: boolean
  viewName: string
  autoDedupeOn: boolean
  onImport: () => void
  onExport: (scope: ExportScope) => void
  onOpenWebhook: () => void
  onRemoveDuplicates: () => void
}

const dot = 'h-2 w-2 rounded-full bg-cube-black'

// The sheet header's Data menu: rows in (a CSV, a webhook), rows out (export)
// and duplicates. Was four buttons beside the column actions.
export const SheetDataMenu: React.FC<Props> = ({
  hasRows, columnCount, isExporting, viewNarrows, viewName, autoDedupeOn,
  onImport, onExport, onOpenWebhook, onRemoveDuplicates,
}) => {
  const focus = useMenuFocus()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button ref={focus.trigger} data-testid="data-menu"
          className="btn-secondary relative flex h-8 items-center gap-1.5"
          aria-label={autoDedupeOn ? 'Data (auto-dedupe on)' : 'Data'} aria-busy={isExporting || undefined}
          title="Import, export, webhook and duplicates">
          {isExporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            : <Database className="h-3.5 w-3.5" aria-hidden="true" />}
          <span className="hidden md:inline">Data</span>
          <ChevronDown className="h-3 w-3 text-gray-500" aria-hidden="true" />
          {/* Auto-dedupe on: a dot on the corner, and the menu says so. */}
          {autoDedupeOn && (
            <span className={`absolute -right-1 -top-1 ring-2 ring-white ${dot}`} data-testid="auto-dedupe-chip">
              <span className="sr-only">(auto-dedupe on)</span>
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72" onCloseAutoFocus={focus.onCloseAutoFocus}>
        <MenuEntry icon={Import} label="Import CSV" hint="Add rows from a file, or replace them"
          onSelect={focus.opening(onImport)} testId="toolbar-import" />
        {viewNarrows ? (
          <>
            <MenuEntry icon={Download} label="Export this view" hint={`${viewName}: its rows and visible columns`}
              onSelect={() => onExport('view')} disabled={!hasRows || isExporting} testId="export-view" />
            <MenuEntry icon={Download} label="Export whole sheet" hint="Every row and column"
              onSelect={() => onExport('sheet')} disabled={!hasRows || isExporting} testId="export-sheet" />
          </>
        ) : (
          <MenuEntry icon={Download} label="Export" hint="Download every row and column as CSV"
            onSelect={() => onExport('sheet')} disabled={!hasRows || isExporting} testId="export-sheet" />
        )}
        <MenuEntry icon={Inbox} label="Webhook" hint="A URL that adds a row for each JSON post"
          onSelect={focus.opening(onOpenWebhook)} testId="toolbar-webhook" />
        <DropdownMenuSeparator />
        <MenuEntry icon={CopyMinus} label="Remove duplicates" onSelect={focus.opening(onRemoveDuplicates)}
          hint={autoDedupeOn ? 'Auto-dedupe is on: new rows with a key already here go to the trash'
            : 'Find repeated rows, or drop them as they arrive'}
          disabled={columnCount === 0} testId="remove-duplicates"
          badge={autoDedupeOn ? <span className={dot} aria-hidden="true" /> : undefined} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
