import React from 'react'
import { Link } from 'react-router-dom'
import { Bot } from 'lucide-react'
import { useAccountDefaultModel } from './ai-modal/useAccountDefaultModel'

// Full-width banner shown above AI-assist controls when NO model would resolve
// for this sheet (sheet default > account default — the same chain the server
// enforces with a 400). Mirrors OpenRouterCreditNotice's banner contract:
// renders NOTHING while loading, on fetch failure, or when a model resolves,
// so callers can drop it at the top of a form without reserving space.
export const NoModelNotice: React.FC<{
  sheetDefaultModel?: string | null
  className?: string
}> = ({ sheetDefaultModel, className }) => {
  const accountDefault = useAccountDefaultModel(true)
  // Only speak up when we KNOW nothing resolves: sheet default absent AND the
  // account default fetched back as explicitly not set (null ≠ undefined).
  if (sheetDefaultModel || accountDefault !== null) return null
  return (
    <div className={`rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 ${className ?? ''}`}>
      <div className="flex items-start gap-2">
        <Bot className="h-4 w-4 mt-0.5 flex-shrink-0" />
        <p>
          <span className="font-medium">No AI model set.</span>{' '}
          <Link to="/settings/ai" className="underline hover:no-underline">Choose a default model in Settings</Link>
          {' '}to use AI assist.
        </p>
      </div>
    </div>
  )
}
