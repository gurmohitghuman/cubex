import React from 'react'
import { Link } from 'react-router-dom'
import { KeyRound } from 'lucide-react'

// Full-width amber banner for anything that runs enrichments: with no treg key
// saved they can't run, so point straight at Settings → Enrichment. Mirrors
// OpenRouterCreditNotice's banner contract: renders NOTHING unless we KNOW
// there's no key (hasKey === false), so callers can drop it at the top of a
// form without reserving space or flashing on the happy path.
export const TregNotice: React.FC<{ hasKey: boolean | undefined; className?: string }> = ({ hasKey, className }) => {
  if (hasKey !== false) return null
  return (
    <div className={`rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 ${className ?? ''}`} data-testid="treg-notice">
      <div className="flex items-start gap-2">
        <KeyRound className="h-4 w-4 mt-0.5 flex-shrink-0" />
        <p>
          <span className="font-medium">No treg key yet.</span>{' '}
          <Link to="/settings/http-enrichment" className="underline hover:no-underline">Add one in Settings</Link>
          {' '}to run enrichments.
        </p>
      </div>
    </div>
  )
}
