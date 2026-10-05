import React from 'react'
import { Loader2, Check, AlertTriangle } from 'lucide-react'
import type { SaveStatus as Status } from '@/hooks/useAutosave'

interface SaveStatusProps {
  status: Status
  onRetry?: () => void
}

// Compact status indicator: idle = hidden, saving / saved / error = visible pill.
export const SaveStatus: React.FC<SaveStatusProps> = ({ status, onRetry }) => {
  if (status === 'idle') return null

  if (status === 'saving') {
    return (
      <div className="flex items-center space-x-1.5 text-xs text-gray-500" aria-live="polite">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Saving…</span>
      </div>
    )
  }

  if (status === 'saved') {
    return (
      <div className="flex items-center space-x-1.5 text-xs text-gray-500" aria-live="polite">
        <Check className="h-3 w-3 text-green-600" />
        <span>All changes saved</span>
      </div>
    )
  }

  // status === 'error'
  return (
    <div className="flex items-center space-x-1.5 text-xs text-red-600" role="alert">
      <AlertTriangle className="h-3 w-3" />
      <span>Save failed</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="ml-1 underline hover:no-underline"
        >
          Retry
        </button>
      )}
    </div>
  )
}
