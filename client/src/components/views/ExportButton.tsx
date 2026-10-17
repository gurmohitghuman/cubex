import React from 'react'
import { Download, Loader2 } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export type ExportScope = 'view' | 'sheet'

interface Props {
  isExporting: boolean
  disabled: boolean
  // The view showing narrows the sheet (filters or hidden columns): ask which to export.
  viewNarrows: boolean
  viewName: string
  onExport: (scope: ExportScope) => void
}

// Export: the whole sheet, or, when the view showing filters rows or hides
// columns, a choice of this view (its rows and visible columns) or the whole sheet.
export const ExportButton: React.FC<Props> = ({ isExporting, disabled, viewNarrows, viewName, onExport }) => {
  const button = (onClick?: () => void) => (
    <button onClick={onClick} disabled={isExporting || disabled} data-testid="export-button"
      className="btn-secondary flex items-center space-x-1 disabled:opacity-50 disabled:cursor-not-allowed">
      {isExporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
      <span>Export</span>
    </button>
  )
  if (!viewNarrows) return button(() => onExport('sheet'))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{button()}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onClick={() => onExport('view')} className="flex-col items-start">
          <span className="truncate max-w-full">This view: {viewName}</span>
          <span className="text-xs text-gray-500">Only its rows and visible columns</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onExport('sheet')} className="flex-col items-start">
          <span>Whole sheet</span>
          <span className="text-xs text-gray-500">Every row and column</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
