import React from 'react'
import { RefreshCw } from 'lucide-react'

// Per-tab loading state (settings tabs each fetch their own data). A small
// inline spinner — never a whole-page gate, so switching tabs feels instant.
export const TabLoading: React.FC = () => (
  <div className="flex items-center justify-center py-16">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cube-black" />
  </div>
)

// First-load failure state with a retry — without it a failed fetch strands
// the tab on the spinner forever (or, worse, renders a false "nothing
// configured yet" empty state).
export const TabLoadFailed: React.FC<{ what: string; onRetry: () => void }> = ({ what, onRetry }) => (
  <div className="text-center py-16">
    <p className="text-gray-600 mb-4">Couldn&apos;t load {what}.</p>
    <button onClick={onRetry} className="btn-primary inline-flex items-center space-x-2 text-sm px-4 py-2">
      <RefreshCw className="h-4 w-4" /><span>Retry</span>
    </button>
  </div>
)
