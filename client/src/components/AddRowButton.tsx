import React, { useRef, useState } from 'react'
import { Plus } from 'lucide-react'

interface AddRowButtonProps {
  onAddRows: (count: number) => void
}

const MAX_PER_ADD = 1000

// "Add [N] more rows" control for the fixed bottom strip below the grid — the
// row analogue of the top-right pinned "Add Column" header. Reads:  [+ Add] [5] more rows
// Clicking Add (or Enter in the box) inserts that many blank rows at the bottom.
// Server clamps to [1, 1000] too; this is the client-side guard + default.
export const AddRowButton: React.FC<AddRowButtonProps> = ({ onAddRows }) => {
  const lastClickTime = useRef(0)
  const [count, setCount] = useState('5')

  const submit = () => {
    const now = Date.now()
    // Debounce double-fire (StrictMode + re-render). 500ms suppresses accidental
    // double-fires without delaying an intentional follow-up click.
    if (now - lastClickTime.current < 500) return
    lastClickTime.current = now
    const parsed = parseInt(count, 10)
    const n = Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, MAX_PER_ADD)) : 1
    onAddRows(n)
  }

  return (
    <div className="flex items-center space-x-2 text-xs text-gray-600">
      <button
        onClick={submit}
        className="flex items-center space-x-1 px-2 py-1 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors duration-150 border border-dashed border-gray-300 hover:border-gray-400 whitespace-nowrap"
        title="Add blank rows"
        aria-label="Add rows"
      >
        <Plus className="h-3 w-3" />
        <span>Add</span>
      </button>
      <input
        type="number"
        min={1}
        max={MAX_PER_ADD}
        value={count}
        onChange={(e) => setCount(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
        className="w-14 px-1.5 py-1 text-center border border-gray-300 rounded focus:outline-none focus:border-cube-black"
        aria-label="Number of rows to add"
      />
      <span>more rows</span>
    </div>
  )
}
