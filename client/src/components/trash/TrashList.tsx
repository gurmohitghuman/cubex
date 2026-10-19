import React from 'react'
import {
  ArchiveRestore, Download, Eye, FileSpreadsheet, Loader2, MoreHorizontal, Rows, Table2, Trash2,
} from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { plural } from '@/lib/utils'
import type { TrashEntry } from '@/utils/api'
import { howText, leftText, placeOf, titleOf, whenText } from './trash-copy'

interface Props {
  items: TrashEntry[]
  selected: Set<number>
  onToggle: (id: number) => void
  onRestore: (e: TrashEntry) => void
  onLook: (e: TrashEntry) => void
  onDownload: (e: TrashEntry) => void
  onDelete: (e: TrashEntry) => void
  busy: Set<number>
}

const ICON = { table: Table2, sheet: FileSpreadsheet, rows: Rows } as const

// One line per deleted thing: what it was, where it came from, how and by whom
// it went, and how long it stays; Restore, and in ⋯ the rest.
export const TrashList: React.FC<Props> = ({
  items, selected, onToggle, onRestore, onLook, onDownload, onDelete, busy,
}) => (
  <ul className="border border-gray-200 rounded-lg divide-y divide-gray-100" data-testid="trash-list">
    {items.map(e => {
      const Icon = ICON[e.kind]
      const working = busy.has(e.id) || e.state !== 'kept'
      return (
        <li key={e.id} className="flex items-start gap-3 px-4 py-3" data-testid="trash-item" data-trash-id={e.id}>
          <input type="checkbox" className="mt-1" checked={selected.has(e.id)} onChange={() => onToggle(e.id)}
            disabled={e.state !== 'kept'} aria-label={`Select ${titleOf(e)}`} />
          <Icon className="h-4 w-4 mt-0.5 text-gray-500 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-900 truncate" data-testid="trash-item-title">{titleOf(e)}</p>
            <p className="text-xs text-gray-600">
              {placeOf(e)} · {howText(e.how)} by {e.by} · {whenText(e.deleted_at)} · {leftText(e)}
            </p>
            {e.state === 'restoring' && (
              <p className="text-xs text-gray-700 flex items-center gap-1 mt-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                Restoring… {plural(e.restored_so_far ?? 0, 'row')} back of {(e.rows + (e.restored_so_far ?? 0))
                  .toLocaleString()}
              </p>
            )}
            {e.state === 'purging' && <p className="text-xs text-gray-700 mt-1">Deleting…</p>}
            {e.state === 'moving' && <p className="text-xs text-gray-700 mt-1">Still being deleted…</p>}
            {e.blocked && <p className="text-xs text-amber-700 mt-1">{e.blocked}</p>}
            {e.note && <p className="text-xs text-gray-600 mt-1">{e.note}</p>}
          </div>
          <button type="button" className="btn-secondary flex items-center gap-1 whitespace-nowrap disabled:opacity-50"
            onClick={() => onRestore(e)} disabled={working || !!e.blocked} data-testid="trash-restore">
            {busy.has(e.id) ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArchiveRestore className="h-3 w-3" />}
            <span>Restore</span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="p-1.5 text-gray-500 hover:text-gray-700" aria-label="More"
                data-testid="trash-more">
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {e.kind === 'rows' && (
                <>
                  <DropdownMenuItem onClick={() => onLook(e)} data-testid="trash-look">
                    <Eye className="h-3.5 w-3.5 mr-2" />Look inside
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onDownload(e)} data-testid="trash-csv">
                    <Download className="h-3.5 w-3.5 mr-2" />Download CSV
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuItem onClick={() => onDelete(e)} disabled={working} className="text-red-600"
                data-testid="trash-delete">
                <Trash2 className="h-3.5 w-3.5 mr-2" />Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      )
    })}
  </ul>
)
