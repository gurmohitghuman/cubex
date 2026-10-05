import React from 'react'

// "Text contains" input for the column header menu. Seeded from the column's
// current filter; applies on Enter or blur — NOT per keystroke, since each apply
// is a server PUT + full reload (the grid is windowed, so filtering is
// server-side). Applying a non-empty value clears any empty/not-empty filter on
// the column (mutual exclusivity — Google Sheets allows one condition per
// column). Clearing the input removes the filter. stopPropagation keeps typing /
// clicking inside the Radix dropdown from closing the menu.
export const ContainsFilterInput: React.FC<{
  columnId: string
  current: string
  onApply: (value: string | null) => void
  hasEmptyFilter: boolean
  onClearEmpty: () => void
}> = ({ columnId, current, onApply, hasEmptyFilter, onClearEmpty }) => {
  const [value, setValue] = React.useState(current)
  // Re-seed when the menu reopens on a different column / after an external change.
  React.useEffect(() => { setValue(current) }, [current, columnId])

  const apply = () => {
    const v = value.trim()
    if (v === current.trim()) return // no-op — avoid a needless PUT + reload
    if (v && hasEmptyFilter) onClearEmpty() // mutual exclusivity
    onApply(v ? v : null)
  }

  // The typed value differs from what's applied → there's a pending change the
  // user must submit. Drives the "Press Enter" hint + the submit affordance so
  // it's clear the filter isn't applied per-keystroke.
  const dirty = value.trim() !== current.trim()

  return (
    <div className="px-2 py-1.5" onKeyDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>
      <div className="flex items-center gap-1">
        <div className="relative flex-1">
          <input
            autoFocus
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); apply() } }}
            onBlur={apply}
            placeholder="Contains…"
            className="w-full text-sm border border-gray-300 rounded px-2 py-1 pr-14 focus:outline-none focus:border-cube-black"
          />
          {/* Submit affordance INSIDE the field: an Enter/↵ pill that appears once
              there's an unapplied change, so it's obvious how to run the search. */}
          {dirty && value.trim() && (
            <button
              onClick={apply}
              className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 text-[10px] font-medium text-gray-500 bg-gray-100 hover:bg-gray-200 rounded px-1.5 py-0.5"
              title="Apply filter"
            >
              Enter ↵
            </button>
          )}
        </div>
        {current && (
          <button
            onClick={() => { setValue(''); onApply(null) }}
            className="text-gray-400 hover:text-gray-700 text-sm px-1"
            title="Clear text filter"
            aria-label="Clear text filter"
          >✕</button>
        )}
      </div>
      {/* Persistent hint so the Enter-to-apply model is discoverable even before
          the user types (the field isn't live/per-keystroke). */}
      <p className="text-[10px] text-gray-400 mt-1">
        {dirty && value.trim() ? 'Press Enter to apply' : 'Type text, then press Enter'}
      </p>
    </div>
  )
}
