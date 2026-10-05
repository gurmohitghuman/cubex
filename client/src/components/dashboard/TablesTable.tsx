import React from 'react'
import { useNavigate } from 'react-router-dom'
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { CubeLogo } from '@/components/CubeLogo'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Table } from '@/utils/api'

const formatDate = (s: string) =>
  new Date(s).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })

// One shared column template for the header AND every row, so every cell snaps
// to the same track — alignment is structural. ALL tracks are FIXED widths
// (Name included) so the table is always the same size regardless of content;
// long names truncate inside the 28rem Name column rather than widening it.
// tabular-nums keeps date/number widths uniform.
const COLS = 'grid-cols-[15rem_8rem_8rem_6rem_3rem]'

interface TablesTableProps {
  tables: Table[]
  onRename: (table: Table) => void
  onDelete: (table: Table) => void
}

export const TablesTable: React.FC<TablesTableProps> = ({ tables, onRename, onDelete }) => {
  const navigate = useNavigate()

  // w-fit: the table shrinks to the exact sum of its fixed columns, so it's the
  // SAME width every time — never stretches to fill the page.
  return (
    <div className="w-fit rounded-lg border border-gray-200 overflow-hidden tabular-nums">
      {/* Header */}
      <div className={`grid ${COLS} items-center gap-x-4 px-4 h-10 bg-gray-50 border-b border-gray-200 meta-label`}>
        <div>Name</div>
        <div>Created</div>
        <div>Updated</div>
        <div>Rows</div>
        <div />
      </div>

      {/* Rows — the whole row is the click target (opens the table). The ⋯ menu
          stops propagation so opening the menu doesn't also open the table. */}
      {tables.map((table) => (
        <div
          key={table.id}
          role="button"
          tabIndex={0}
          onClick={() => navigate(`/table/${table.id}`)}
          onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/table/${table.id}`) }}
          className={`group grid ${COLS} items-center gap-x-4 px-4 h-14 border-b border-gray-100 last:border-b-0 hover:bg-gray-50 transition-colors cursor-pointer focus:outline-none focus:bg-gray-50`}
        >
          {/* Name */}
          <div className="flex items-center gap-3 min-w-0">
            <CubeLogo size="sm" className="flex-shrink-0" />
            <span className="text-sm font-medium text-gray-900 truncate group-hover:text-gray-700 transition-colors">
              {table.name}
            </span>
          </div>

          <div className="text-xs text-gray-500">{formatDate(table.created_at)}</div>
          <div className="text-xs text-gray-500">{formatDate(table.updated_at)}</div>
          <div className="text-sm font-medium text-gray-700">
            {(table.row_count || 0).toLocaleString()}
          </div>

          {/* ⋯ actions menu */}
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  onClick={(e) => e.stopPropagation()}
                  className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors focus:outline-none"
                  title="Table actions"
                  aria-label="Table actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4} className="w-40" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem onClick={() => onRename(table)}>
                  <Pencil className="h-4 w-4 mr-2" /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => onDelete(table)}
                  className="text-red-600 focus:text-red-600 focus:bg-red-50"
                >
                  <Trash2 className="h-4 w-4 mr-2" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      ))}
    </div>
  )
}
