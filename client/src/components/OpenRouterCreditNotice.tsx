import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Sparkles, KeyRound } from 'lucide-react'
import { settingsAPI } from '@/utils/api'

// One-line notice shown next to any control that spends the user's OpenRouter
// credits (AI Add Column, HTTP "AI assist", troubleshoot). Two jobs:
//   1. Disclosure — the action bills the user's own OpenRouter key, not ours.
//   2. Onboarding — if no key is configured, the AI call would just error; instead
//      we surface a link straight to Settings so they can add one.
// Self-fetches key status (cheap GET /settings, cached by the browser) so callers
// don't have to thread it through. While loading we show the neutral disclosure.
// `inline` (default): a one-liner meant to sit beside a control — short neutral
//   disclosure when a key exists, short amber warning when it doesn't.
// `banner`: a full-width amber card for the no-key case, meant to sit ABOVE a
//   form section. Renders NOTHING when a key is present (or while loading), so a
//   caller can drop it at the top of a modal without reserving space. Introduced
//   because the inline no-key variant, placed next to a field label, wrapped and
//   collided with the label (see AI Column modal). The banner lifts that message
//   out of the label row entirely.
export const OpenRouterCreditNotice: React.FC<{
  className?: string
  variant?: 'inline' | 'banner'
  // When true, the inline variant shows ONLY the neutral "Uses your OpenRouter
  // credits" disclosure and never the amber no-key warning — use this when a
  // sibling `variant="banner"` already carries the no-key message, so it isn't
  // said twice (and the long amber text can't wrap into an adjacent label).
  neutralOnly?: boolean
}> = ({ className, variant = 'inline', neutralOnly = false }) => {
  // undefined = still loading; true/false = known.
  const [hasKey, setHasKey] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    let alive = true
    settingsAPI.get()
      .then(s => { if (alive) setHasKey(!!s.hasOpenRouterKey) })
      .catch(() => { if (alive) setHasKey(undefined) }) // network error → fall back to disclosure
    return () => { alive = false }
  }, [])

  if (variant === 'banner') {
    // Only speak up when we KNOW there's no key. Loading/present/error → render
    // nothing so the banner never reserves space or flashes on happy paths.
    if (hasKey !== false) return null
    return (
      <div className={`rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 ${className ?? ''}`}>
        <div className="flex items-start gap-2">
          <KeyRound className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <p>
            <span className="font-medium">No OpenRouter key yet.</span>{' '}
            <Link to="/settings/ai" className="underline hover:no-underline">Add one in Settings</Link>
            {' '}to run AI.
          </p>
        </div>
      </div>
    )
  }

  if (hasKey === false && !neutralOnly) {
    return (
      <span className={`inline-flex items-center gap-1 text-xs text-amber-700 ${className ?? ''}`}>
        <KeyRound className="h-3.5 w-3.5" />
        No OpenRouter key yet.{' '}
        <Link to="/settings/ai" className="underline hover:text-amber-800">Add one in Settings</Link>
        {' '}to use AI.
      </span>
    )
  }

  return (
    <span className={`inline-flex items-center gap-1 text-xs text-gray-400 ${className ?? ''}`}>
      <Sparkles className="h-3.5 w-3.5" />
      Uses your OpenRouter credits
    </span>
  )
}
