import React from 'react'
import { Download, Edit3, Trash2 } from 'lucide-react'
import { SETUP_KIND_LABEL, type SetupSummary } from '@/utils/api/setups'
import { plural } from '@/lib/utils'

const ICON_BUTTON = 'p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors'

// One saved setup in Settings: its steps in order, the columns a sheet needs
// for it and the saved keys it uses, with rename, export and delete.
export const SetupCard: React.FC<{
  setup: SetupSummary; onEdit: () => void; onExport: () => void; onDelete: () => void
}> = ({ setup: s, onEdit, onExport, onDelete }) => (
  <div className="p-4 border border-gray-200 rounded-lg" data-testid="setup-card">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="font-medium text-gray-900">{s.name}</p>
        {s.description && <p className="text-sm text-gray-500">{s.description}</p>}
      </div>
      <div className="flex items-center space-x-1 shrink-0">
        <button onClick={onEdit} className={ICON_BUTTON} title="Rename or describe" aria-label={`Edit ${s.name}`}>
          <Edit3 className="h-4 w-4" />
        </button>
        <button onClick={onExport} className={ICON_BUTTON} title="Export as a file" aria-label={`Export ${s.name}`}>
          <Download className="h-4 w-4" />
        </button>
        <button onClick={onDelete} className={ICON_BUTTON} title="Delete" aria-label={`Delete ${s.name}`}>
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
    <ol className="mt-3 flex flex-wrap gap-1.5 text-xs">
      {s.steps.map((step, i) => (
        <li key={step.column} className="bg-gray-100 text-gray-700 px-2 py-1">
          {i + 1}. {step.column} <span className="text-gray-500">· {SETUP_KIND_LABEL[step.kind]}</span>
        </li>
      ))}
    </ol>
    <p className="mt-2 text-xs text-gray-500">
      Needs {s.inputs.length ? s.inputs.join(', ') : 'no columns'}
      {s.keys.length > 0 && <> · Uses saved {s.keys.length === 1 ? 'key' : 'keys'} {s.keys.join(', ')}</>}
      {s.use_count > 0 && <> · Used {plural(s.use_count, 'time')}</>}
    </p>
  </div>
)
