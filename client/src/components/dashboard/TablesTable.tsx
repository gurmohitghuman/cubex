import React, { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowDown, ArrowUp, ExternalLink, Loader2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { CubeLogo } from '@/components/CubeLogo'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Table } from '@/utils/api'
import { sortTables, type SortKey, type TableSort, useTableSort } from './tableSort'

const formatDate = (s: string) =>
  new Date(s).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })

// One column template for the header and every row, so each cell sits in the same track. The name takes what is
// left; Updated shows from 768 px and Created from 1024 px, so a phone keeps the name, rows and runs.
const COLS = 'grid-cols-[minmax(0,1fr)_5.5rem_6.5rem_2.5rem] '
  + 'md:grid-cols-[minmax(0,1fr)_6.5rem_7.5rem_7.5rem_2.5rem] '
  + 'lg:grid-cols-[minmax(0,1fr)_7rem_8rem_8rem_8rem_2.5rem]'

const HEADERS: Array<{ key: SortKey; label: string; className?: string }> = [
  { key: 'name', label: 'Name' }, { key: 'rows', label: 'Rows' }, { key: 'runs', label: 'Runs' },
  { key: 'updated', label: 'Updated', className: 'hidden md:flex' },
  { key: 'created', label: 'Created', className: 'hidden lg:flex' },
]

// "2 running, 1 paused", or nothing while the table has no runs.
const runsText = (t: Table): string | null => {
  const r = t.runs
  if (!r) return null
  const parts = [r.running ? `${r.running} running` : '', r.paused ? `${r.paused} paused` : ''].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

interface TablesTableProps {
  tables: Table[]
  onRename: (table: Table) => void
  onDelete: (table: Table) => void
  // The row counts are shown as they are while the home waits for a slot to count them (no spinner).
  countsPlain?: boolean
}

const SortHeader: React.FC<{ h: typeof HEADERS[number]; sort: TableSort; onSort: (k: SortKey) => void }> = (
  { h, sort, onSort },
) => {
  const on = sort.key === h.key
  const Arrow = sort.dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <button type="button" onClick={() => onSort(h.key)} data-testid={`sort-${h.key}`}
      data-sort={on ? sort.dir : undefined} title={`Sort by ${h.label.toLowerCase()}`}
      className={`${h.className ?? 'flex'} items-center gap-1 text-left hover:text-gray-900 ${
        on ? 'text-gray-900' : ''}`}>
      {h.label}
      {on && <Arrow className="h-3 w-3" aria-label={sort.dir === 'asc' ? 'ascending' : 'descending'} />}
    </button>
  )
}

// The home's list of tables: the page's width, sorted by a header's click (newest updated first until then).
export const TablesTable: React.FC<TablesTableProps> = ({ tables, onRename, onDelete, countsPlain }) => {
  const navigate = useNavigate()
  const [sort, onSort] = useTableSort()
  const shown = useMemo(() => sortTables(tables, sort), [tables, sort])

  return (
    <div className="w-full rounded-lg border border-gray-200 tabular-nums" data-testid="tables-list">
      <div className={`grid ${COLS} meta-label h-10 items-center gap-x-4 rounded-t-lg border-b border-gray-200
        bg-gray-50 px-4`}>
        {HEADERS.map(h => <SortHeader key={h.key} h={h} sort={sort} onSort={onSort} />)}
        <div />
      </div>

      {/* Rows: the whole row opens the table, by Enter too. The ⋯ menu and the runs link stop the click there, and
          Enter opens it only from the row itself: the keys of its ⋯ button and its menu reach the row through
          React too. */}
      {shown.map((table) => {
        const runs = runsText(table)
        const sheets = table.sheets?.length ?? 0
        const counting = !!table.row_count_updating && !countsPlain
        return (
          <div
            key={table.id}
            role="button"
            tabIndex={0}
            data-testid="table-row"
            data-table-id={table.id}
            onClick={() => navigate(`/table/${table.id}`)}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) navigate(`/table/${table.id}`) }}
            className={`group grid ${COLS} h-14 cursor-pointer items-center gap-x-4 border-b border-gray-100 px-4
              transition-colors last:border-b-0 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none`}
          >
            <div className="flex min-w-0 items-center gap-3">
              <CubeLogo size="sm" className="flex-shrink-0" />
              <span className="truncate text-sm font-medium text-gray-900" data-testid="table-name">{table.name}</span>
              {sheets > 1 && (
                <span className="flex-shrink-0 text-xs text-gray-400" data-testid="table-sheet-count">
                  {sheets} sheets
                </span>
              )}
            </div>

            {/* Updating: the last count, while the server counts the rows again (they changed since). */}
            <div
              className={`flex items-center gap-1.5 text-sm font-medium ${
                counting ? 'text-gray-400' : 'text-gray-700'}`}
              data-testid="table-row-count"
              data-table-id={table.id}
              title={counting ? 'Counting the rows again' : undefined}
            >
              {(table.row_count || 0).toLocaleString()}
              {counting && <Loader2 className="h-3 w-3 animate-spin" aria-label="Updating" />}
            </div>

            <div className="min-w-0 text-xs">
              {runs && table.runs && (
                <Link to={`/table/${table.id}/${table.runs.sheet_id}`} onClick={(e) => e.stopPropagation()}
                  data-testid="table-runs" data-table-id={table.id} title="Open the sheet with the runs"
                  className="inline-flex max-w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-gray-700
                    hover:bg-gray-100 hover:text-gray-900">
                  <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                    table.runs.running ? 'bg-cube-black' : 'bg-gray-400'}`} />
                  <span className="truncate">{runs}</span>
                </Link>
              )}
            </div>

            <div className="hidden text-xs text-gray-500 md:block">{formatDate(table.updated_at)}</div>
            <div className="hidden text-xs text-gray-500 lg:block">{formatDate(table.created_at)}</div>

            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    onClick={(e) => e.stopPropagation()}
                    className="rounded p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700
                      focus:outline-none"
                    title="Table actions"
                    aria-label="Table actions"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={4} className="w-40" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenuItem onClick={() => navigate(`/table/${table.id}`)} data-testid="table-open">
                    <ExternalLink className="mr-2 h-4 w-4" /> Open
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onRename(table)}>
                    <Pencil className="mr-2 h-4 w-4" /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => onDelete(table)}
                    className="text-red-600 focus:bg-red-50 focus:text-red-600"
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )
      })}
    </div>
  )
}
