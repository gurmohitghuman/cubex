import React from 'react'
import { Popover, PopoverButton, PopoverPanel } from '@headlessui/react'
import { Filter, X } from 'lucide-react'
import toast from 'react-hot-toast'
import type { SheetData } from '@/utils/api'
import type { WhereItem } from '@/utils/api/views'
import { isRunColumn } from '@/lib/filters'
import { onConditions, sheetWhere, whereWords } from '@/lib/views'
import { FilterPanel } from './FilterPanel'

// "Filter" above the grid: the active view's filter in words (header filters
// included), the panel that edits all of it, and ✕ to clear it. The panel
// opens on the filter as saved; its draft lives only while it's open.
export const FilterButton: React.FC<{
  sheetData: SheetData
  columns: string[]
  save: (where: WhereItem[] | null) => Promise<string | null>
}> = ({ sheetData, columns, save }) => {
  const where = sheetWhere(sheetData)
  const on = onConditions(where).length
  const words = whereWords(where)
  const columnTypes = sheetData.data.columnTypes ?? {}
  const ctx = {
    sheetId: sheetData.sheet.id, columns, columnTypes,
    hasRunColumns: Object.values(columnTypes).some(isRunColumn),
  }
  const clear = () => void save(null).then(problem => { if (problem) toast.error(problem) })
  return (
    <div className="flex items-center min-w-0">
      <Popover className="min-w-0">
        <PopoverButton data-testid="filter-button" title={words || 'Show only the rows you want'}
          className={`flex items-center gap-1.5 min-w-0 max-w-md text-xs rounded px-2 py-1 border ${
            where.length ? 'bg-gray-100 border-gray-300 rounded-r-none' : 'btn-secondary !py-1'}`}>
          <Filter className="h-3 w-3 flex-shrink-0 text-gray-500" />
          {where.length === 0 ? <span>Filter</span>
            : on === 0 ? <span>Filter (all rules off)</span>
            : <span className="truncate">{words}</span>}
        </PopoverButton>
        <PopoverPanel anchor={{ to: 'bottom start', gap: 4 }} transition
          className="z-50 bg-white border border-gray-200 rounded-lg shadow-lg">
          <FilterPanel where={where} ctx={ctx} save={save} />
        </PopoverPanel>
      </Popover>
      {where.length > 0 && (
        <button type="button" onClick={clear} aria-label="Clear all filters" title="Clear all filters"
          className="self-stretch px-1.5 border border-l-0 border-gray-300 rounded-r bg-gray-100 text-gray-500
            hover:text-gray-900">
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}
