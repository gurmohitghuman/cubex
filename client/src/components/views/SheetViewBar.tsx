import React, { useState } from 'react'
import { Filter, X } from 'lucide-react'
import type { SheetData } from '@/utils/api'
import type { SheetViews } from '@/hooks/sheet/useSheetViews'
import { isRunColumn } from '@/lib/filters'
import { rowFilterOf, rowFilterWords } from '@/lib/views'
import { ViewMenu } from './ViewMenu'
import { ColumnsPicker } from './ColumnsPicker'
import { ViewDialog, type ViewDialogState } from './ViewDialog'

interface Props {
  views: SheetViews
  sheetData: SheetData | null
  columns: string[]
}

// The bar above the grid: which view is showing, its hidden columns, and the
// view's filters that no column header shows (an error in any run column, an
// OR group), each in words with a way to clear them.
export const SheetViewBar: React.FC<Props> = ({ views, sheetData, columns }) => {
  const [dialog, setDialog] = useState<ViewDialogState>(null)
  const rowFilter = rowFilterOf(sheetData)
  const hasRunColumns = Object.values(sheetData?.data.columnTypes ?? {}).some(isRunColumn)
  if (!sheetData) return null
  return (
    <div className="flex items-center gap-2 px-6 py-1.5 bg-white border-b border-gray-200 flex-shrink-0 min-w-0"
      data-testid="view-bar">
      <ViewMenu views={views} hasRunColumns={hasRunColumns} openDialog={setDialog} />
      <ColumnsPicker columns={columns} hidden={views.hiddenColumns} onChange={views.setHidden} />
      {rowFilter.length > 0 && (
        <span className="flex items-center gap-1.5 min-w-0 text-xs bg-gray-100 border border-gray-200 rounded px-2 py-1"
          data-testid="row-filter-chip">
          <Filter className="h-3 w-3 flex-shrink-0 text-gray-500" />
          <span className="truncate">{rowFilter.map(rowFilterWords).join(' and ')}</span>
          <button onClick={() => void views.clearRowFilter()} aria-label="Clear this filter"
            className="text-gray-500 hover:text-gray-900"><X className="h-3 w-3" /></button>
        </span>
      )}
      <ViewDialog state={dialog} onClose={() => setDialog(null)} onCreate={views.create} onSave={views.rename}
        onDelete={views.remove} />
    </div>
  )
}
