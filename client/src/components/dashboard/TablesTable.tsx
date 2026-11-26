import React, { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowDown, ArrowUp, ExternalLink, Loader2, MoreHorizontal, Pencil, Star, Trash2 } from 'lucide-react'
import { CubeLogo } from '@/components/CubeLogo'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Table } from '@/utils/api'
import { sortTables, type SortKey, type TableSort, useTableSort } from './tableSort'

const formatDate = (s: string) =>
  new Date(s).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })

// One column template (and gap) for the header and every row, so each cell sits in the same track. The name takes
// what is left, then the star. Runs shows from 640 px, Last opened and Updated from 1024 px, Created from 1280 px:
// a phone keeps the name (about 110 px of it at 390), the star, the rows and the ⋯ menu, and the name keeps room at
// 768 px beside the open sidebar.
const COLS = 'grid-cols-[minmax(0,1fr)_1.75rem_4.5rem_2rem] gap-x-2 '
  + 'sm:grid-cols-[minmax(0,1fr)_1.75rem_5.5rem_6.5rem_2.5rem] sm:gap-x-4 '
  + 'lg:grid-cols-[minmax(0,1fr)_1.75rem_6rem_7rem_6.5rem_6.5rem_2.5rem] '
  + 'xl:grid-cols-[minmax(0,1fr)_1.75rem_6.5rem_7.5rem_7rem_7rem_7rem_2.5rem]'

const HEADERS: Array<{ key: SortKey; label: string; className?: string }> = [
  { key: 'rows', label: 'Rows' }, { key: 'runs', label: 'Runs', className: 'hidden sm:flex' },
  { key: 'opened', label: 'Last opened', className: 'hidden lg:flex' },
  { key: 'updated', label: 'Updated', className: 'hidden lg:flex' },
  { key: 'created', label: 'Created', className: 'hidden xl:flex' },
]
const NAME_HEADER: typeof HEADERS[number] = { key: 'name', label: 'Name' }

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
  // The star: in or out of Favorites, shown at once.
  onStar: (table: Table) => void
  // The Recent tab: its own sort, the tables opened last first until a header is clicked.
  recent?: boolean
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

// The home's list of tables: the page's width, sorted by a header's click (newest updated first until then, or on
// Recent the last opened first).
export const TablesTable: React.FC<TablesTableProps> = (
  { tables, onRename, onDelete, onStar, recent, countsPlain },
) => {
  const navigate = useNavigate()
  const [sort, onSort] = useTableSort(recent)
  const shown = useMemo(() => sortTables(tables, sort), [tables, sort])

  return (
    <div className="w-full rounded-lg border border-gray-200 tabular-nums" data-testid="tables-list">
      <div className={`grid ${COLS} meta-label h-10 items-center rounded-t-lg border-b border-gray-200
        bg-gray-50 px-4`}>
        <SortHeader h={NAME_HEADER} sort={sort} onSort={onSort} />
        <div><span className="sr-only">Favorite</span></div>
        {HEADERS.map(h => <SortHeader key={h.key} h={h} sort={sort} onSort={onSort} />)}
        <div />
      </div>

      {/* Rows: the whole row opens the table, by Enter too. The star, the ⋯ menu and the runs link stop the click
          there, and Enter opens it only from the row itself: the keys of its buttons and its menu reach the row
          through React too. */}
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
            className={`group grid ${COLS} h-14 cursor-pointer items-center border-b border-gray-100 px-4
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

            <button type="button" onClick={(e) => { e.stopPropagation(); onStar(table) }}
              aria-pressed={!!table.starred} data-testid="table-star" data-table-id={table.id}
              aria-label={table.starred ? `Remove ${table.name} from Favorites` : `Add ${table.name} to Favorites`}
              title={table.starred ? 'Remove from Favorites' : 'Add to Favorites'}
              className="flex h-7 w-7 items-center justify-center rounded hover:bg-gray-100 focus:outline-none
                focus-visible:ring-2 focus-visible:ring-gray-300">
              <Star className={`h-4 w-4 ${table.starred ? 'fill-gray-900 text-gray-900'
                : 'text-gray-300 group-hover:text-gray-400'}`} />
            </button>

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

            <div className="hidden min-w-0 text-xs sm:block">
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

            <div className="hidden text-xs text-gray-500 lg:block" data-testid="table-opened">
              {table.last_opened_at ? formatDate(table.last_opened_at) : ''}
            </div>
            <div className="hidden text-xs text-gray-500 lg:block">{formatDate(table.updated_at)}</div>
            <div className="hidden text-xs text-gray-500 xl:block">{formatDate(table.created_at)}</div>

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
