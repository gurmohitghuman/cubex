import React from 'react'
import { Import, Plus } from 'lucide-react'
import { CubeLogo } from '@/components/CubeLogo'

interface SheetEmptyStateProps {
  onImport: () => void
  // Starts an empty sheet by hand: the first column also creates the first row.
  onAddColumn?: () => void
}

export const SheetEmptyState: React.FC<SheetEmptyStateProps> = ({ onImport, onAddColumn }) => (
  <div className="iso-grid h-full flex items-center justify-center">
    <div className="relative z-10 text-center max-w-sm mx-auto">
      <CubeLogo size="lg" className="mx-auto mb-4" />
      <h3 className="text-title text-gray-900 mb-2">Ready for data</h3>
      <p className="text-gray-500 mb-6 text-sm">Import a CSV file, or add a column and start typing</p>
      <div className="flex items-center justify-center gap-2">
        <button onClick={onImport} className="btn-primary flex items-center space-x-2">
          <Import className="h-3 w-3" />
          <span>Import CSV</span>
        </button>
        {onAddColumn && (
          <button onClick={onAddColumn} className="btn-secondary flex items-center space-x-2">
            <Plus className="h-3 w-3" />
            <span>Add a column</span>
          </button>
        )}
      </div>
    </div>
  </div>
)
