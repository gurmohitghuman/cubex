import React, { useRef } from 'react'
import { IHeaderParams } from 'ag-grid-community'
import { Plus } from 'lucide-react'

interface AddColumnHeaderProps extends IHeaderParams {
  onAddColumn: () => void
}

export const AddColumnHeader: React.FC<AddColumnHeaderProps> = ({ onAddColumn }) => {
  const lastClickTime = useRef(0)
  
  const handleAddColumn = () => {
    const now = Date.now()
    // Debounce double-clicks (StrictMode + AG Grid header re-renders fire
    // the handler twice in dev). 500ms is enough to suppress accidental
    // double-fires without delaying intentional follow-up clicks.
    if (now - lastClickTime.current < 500) return
    lastClickTime.current = now
    onAddColumn()
  }

  return (
    <div className="ag-header-cell-text flex items-center justify-center w-full h-full">
      <button
        onClick={handleAddColumn}
        className="flex items-center space-x-1 px-2 py-1 text-xs text-gray-600 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors duration-150 border border-dashed border-gray-300 hover:border-gray-400 whitespace-nowrap"
        title="Add new column"
        aria-label="Add new column"
      >
        <Plus className="h-3 w-3" />
        <span>Add Column</span>
      </button>
    </div>
  )
}