import React from 'react'

interface Props {
  state: { x: number; y: number; oldName: string; value: string } | null
  setState: (s: { x: number; y: number; oldName: string; value: string } | null) => void
  onRenameColumn?: (oldName: string, newName: string) => boolean | void | Promise<boolean | void>
}

// Inline popover anchored above the column header. Closes on Cancel / Esc always, and on
// Save / Enter only when the rename succeeds — a failed rename (duplicate name, network
// error) keeps the popover open with the typed value so the user can fix it and retry.
export const RenameColumnPopover: React.FC<Props> = ({ state, setState, onRenameColumn }) => {
  if (!state) return null

  const commit = async () => {
    const newName = state.value.trim()
    // No-op rename (empty or unchanged): just close.
    if (!newName || newName === state.oldName) { setState(null); return }
    const ok = await onRenameColumn?.(state.oldName, newName)
    // Treat undefined (handler returned nothing) as success for back-compat;
    // only an explicit `false` keeps the popover open.
    if (ok !== false) setState(null)
  }

  return (
    <div
      style={{ position: 'absolute', top: Math.max(0, state.y - 36), left: state.x, zIndex: 60, minWidth: 220 }}
      className="bg-white border border-gray-300 rounded-md shadow-lg p-2 flex items-center space-x-2"
      onKeyDown={async (e) => {
        if (e.key === 'Enter') { e.preventDefault(); await commit() }
        else if (e.key === 'Escape') { e.preventDefault(); setState(null) }
      }}
    >
      <input
        autoFocus
        value={state.value}
        onChange={(e) => setState({ ...state, value: e.target.value })}
        className="input !py-1 !px-2 flex-1"
        placeholder="New column name"
      />
      <button className="btn-primary !py-1" onClick={commit}>Save</button>
      <button className="btn-secondary !py-1" onClick={() => setState(null)}>Cancel</button>
    </div>
  )
}
