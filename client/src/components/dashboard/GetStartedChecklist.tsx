import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, X } from 'lucide-react'

// First-run activation checklist. Front-loads the OpenRouter-key requirement so
// a new user learns about it on the dashboard — NOT at the dead-end moment they
// click "AI Column" and the run is blocked server-side.
//
// Progress is DERIVED FROM REAL DATA (tables exist, key configured), never a
// persisted "completed" flag — a stored flag drifts and would show "incomplete"
// to existing users who already have tables/keys. localStorage holds ONLY the
// manual dismissal, so an experienced user can clear it early and it stays gone.
//
// Auto-hides once there's nothing left to nudge (a key AND at least one table),
// so it silently disappears for established accounts without a dismiss.
const DISMISS_KEY = 'cubex-getstarted-dismissed'

interface Props {
  hasTables: boolean
  hasKey: boolean
}

export const GetStartedChecklist: React.FC<Props> = ({ hasTables, hasKey }) => {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
  })

  // Nothing left to guide → don't render. (Also the natural end-state: once the
  // user has a table and a key, the checklist is fully satisfied.)
  if (hasTables && hasKey) return null
  if (dismissed) return null

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* private mode — hide for this session only */ }
    setDismissed(true)
  }

  // "Import a CSV" has no reliable dashboard-level signal, so we don't fake its
  // done-state — "Create a table" standing in as the first concrete step is
  // enough for v1. The key step is the one that actually
  // unblocks AI, so it carries the link.
  const steps: Array<{ done: boolean; label: React.ReactNode }> = [
    { done: hasTables, label: 'Create a table and import your data' },
    {
      done: hasKey,
      label: (
        <>
          Add your OpenRouter key in{' '}
          <Link to="/settings/ai" className="underline hover:no-underline font-medium">Settings</Link>
          {' '}to unlock AI columns
        </>
      ),
    },
  ]

  return (
    <div className="card p-5 mb-6 relative">
      <button
        onClick={dismiss}
        className="absolute top-3 right-3 p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
        title="Dismiss"
        aria-label="Dismiss getting-started checklist"
      >
        <X className="h-4 w-4" />
      </button>

      <h3 className="text-title text-gray-900 mb-1">Get started with Cubex</h3>
      <p className="text-sm text-gray-500 mb-4">Two quick steps to run AI across your rows.</p>

      <ul className="space-y-2.5">
        {steps.map((step, i) => (
          <li key={i} className="flex items-center gap-3">
            <span
              className={
                'flex-shrink-0 h-5 w-5 rounded-full flex items-center justify-center ' +
                (step.done ? 'bg-cube-black text-white' : 'border border-gray-300 text-gray-400')
              }
            >
              {step.done ? <Check className="h-3 w-3" /> : <span className="text-xs">{i + 1}</span>}
            </span>
            <span className={'text-sm ' + (step.done ? 'text-gray-400 line-through' : 'text-gray-700')}>
              {step.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
