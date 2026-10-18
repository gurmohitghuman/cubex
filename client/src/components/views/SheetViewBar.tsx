import React, { useState } from 'react'
import type { SheetData } from '@/utils/api'
import type { SheetViews } from '@/hooks/sheet/useSheetViews'
import { isRunColumn } from '@/lib/filters'
import { FilterButton } from '@/components/filters/FilterButton'
import { ViewMenu } from './ViewMenu'
import { ColumnsPicker } from './ColumnsPicker'
import { ViewDialog, type ViewDialogState } from './ViewDialog'
import { SheetSearchBar } from './SheetSearchBar'
import type { SheetSearch } from '@/hooks/sheet/useSheetSearch'

interface Props {
  views: SheetViews
  sheetData: SheetData | null
  columns: string[]
  search: SheetSearch
}

// The bar above the grid: which view is showing, its hidden columns, and its
// filter (in words, edited in the filter panel, cleared with ✕); and search,
// on the right.
export const SheetViewBar: React.FC<Props> = ({ views, sheetData, columns, search }) => {
  const [dialog, setDialog] = useState<ViewDialogState>(null)
  const hasRunColumns = Object.values(sheetData?.data.columnTypes ?? {}).some(isRunColumn)
  if (!sheetData) return null
  return (
    <div className="flex items-center gap-2 px-6 py-1.5 bg-white border-b border-gray-200 flex-shrink-0 min-w-0"
      data-testid="view-bar">
      <ViewMenu views={views} hasRunColumns={hasRunColumns} openDialog={setDialog} />
      <ColumnsPicker columns={columns} hidden={views.hiddenColumns} onChange={views.setHidden} />
      <FilterButton sheetData={sheetData} columns={columns} save={views.saveFilters} />
      <SheetSearchBar search={search} />
      <ViewDialog state={dialog} onClose={() => setDialog(null)} onCreate={views.create} onSave={views.rename}
        onDelete={views.remove} />
    </div>
  )
}
