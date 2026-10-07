import React from 'react'
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react'
import type { ProviderRow } from './providers'
import { ACCESS_TEXT, providerLine } from './copy'
import { Tag } from './ToolCard'

// on/off: the user's switch. locked: async or retired, can't run in a sheet.
// out: treg's own account for it is empty right now. inputs: can't use the
// inputs mapped so far.
export type ProviderState = 'on' | 'off' | 'locked' | 'out' | 'inputs'

interface Props {
  row: ProviderRow
  state: ProviderState
  needs: string
  movable: boolean
  first: boolean
  last: boolean
  dragOver: boolean
  onToggle: () => void
  onMove: (delta: -1 | 1) => void
  drag: { onDragStart: () => void; onDragOver: (e: React.DragEvent) => void; onDrop: () => void; onDragEnd: () => void }
}

export const Switch: React.FC<{ on: boolean; disabled?: boolean; label: string; onClick: () => void }> = ({ on, disabled, label, onClick }) => (
  <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onClick}
    className={`relative inline-flex h-4 w-7 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${on ? 'bg-cube-black' : 'bg-gray-300'}`}>
    <span className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${on ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
  </button>
)

function detail(row: ProviderRow, state: ProviderState, needs: string): string {
  if (state === 'locked') return row.unavailable === 'async' ? 'Answers later, not supported yet' : 'Retired by treg'
  if (state === 'out') return "treg's own account for it is empty right now, so it's skipped"
  if (state === 'inputs') return `Needs ${needs}`
  return row.access ? `${ACCESS_TEXT[row.access]}${row.access === 'connected' ? ` · ${providerLine(row)}` : ''}` : providerLine(row)
}

export const ProviderItem: React.FC<Props> = ({ row, state, needs, movable, first, last, dragOver, onToggle, onMove, drag }) => {
  const dim = state !== 'on'
  return (
    <li
      draggable={movable}
      onDragStart={movable ? drag.onDragStart : undefined}
      onDragOver={movable ? drag.onDragOver : undefined}
      onDrop={movable ? drag.onDrop : undefined}
      onDragEnd={movable ? drag.onDragEnd : undefined}
      className={`flex items-center gap-2 px-2 py-1.5 ${dragOver ? 'bg-gray-100' : ''}`}
      data-testid="enrich-provider"
    >
      {movable
        ? <GripVertical className="h-4 w-4 flex-shrink-0 text-gray-300 cursor-grab" aria-hidden="true" />
        : <span className="w-4 flex-shrink-0" />}
      <Switch on={state === 'on'} disabled={state === 'locked' || state === 'out'} label={`Use ${row.name}`} onClick={onToggle} />
      <div className="flex-1 min-w-0">
        <p className={`text-sm flex items-center gap-1.5 ${dim ? 'text-gray-400' : 'text-gray-900'}`}>
          <span className="truncate">{row.name}</span>
          {row.access === 'own' && <Tag>your key</Tag>}
          {row.access === 'free' && <Tag>free</Tag>}
        </p>
        <p className="text-xs text-gray-500 truncate">{detail(row, state, needs)}</p>
      </div>
      {movable && (
        <span className="flex flex-shrink-0">
          <button type="button" onClick={() => onMove(-1)} disabled={first} aria-label={`Move ${row.name} up`}
            className="p-0.5 text-gray-400 hover:text-cube-black disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
          <button type="button" onClick={() => onMove(1)} disabled={last} aria-label={`Move ${row.name} down`}
            className="p-0.5 text-gray-400 hover:text-cube-black disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
        </span>
      )}
    </li>
  )
}
