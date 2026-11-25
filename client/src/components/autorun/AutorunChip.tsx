import React, { useEffect, useRef, useState } from 'react'
import { Zap } from 'lucide-react'
import type { AutorunControls } from '@/hooks/sheet/useAutorun'
import type { WaitingRows } from '@/utils/api/autorun'
import { autorunUsage, chipState, pauseLabel } from './autorun-copy'

const TONE = {
  on: 'border-gray-300 text-gray-700 bg-white',
  amber: 'border-amber-300 text-amber-800 bg-amber-50',
  muted: 'border-gray-200 text-gray-500 bg-gray-50',
}

// The sheet header's auto-run chip: on while any column has auto-run on, amber
// when one is paused ("Auto-run paused: daily limit"), "manual" when every one is paused by hand. It opens a list
// of the sheet's auto-runs, each with its settings, and pauses or resumes them all; a resume asks what the rows
// added or changed meanwhile do (services/autorun-resume.ts on the server).
const RESUME: Array<[WaitingRows, string, string]> = [
  // A cell with a result never runs again either way: the two differ only on a row that failed.
  ['run', 'Run the rows that waited', 'Rows added or changed while paused run now; a failed row tries again.'],
  ['empty_only', 'Keep existing results', 'The same, but a failed row keeps its error.'],
  ['skip', 'Continue without running them', 'Only rows added or changed from now on run.'],
]
export const AutorunChip: React.FC<{ autorun: AutorunControls }> = ({ autorun }) => {
  const [open, setOpen] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (!open) setChoosing(false) }, [open])
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus() } }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', escape) }
  }, [open])
  const state = chipState(autorun.view)
  if (!state) return null
  const on = Object.values(autorun.view?.columns ?? {}).filter(c => c.enabled)
  const anyGoing = on.some(c => c.pausedReason !== 'user')
  return (
    <div className="relative shrink-0" ref={ref}
      onBlur={e => { if (e.relatedTarget && !ref.current?.contains(e.relatedTarget as Node)) setOpen(false) }}>
      <button type="button" ref={button} onClick={() => setOpen(o => !o)} data-testid="autorun-chip"
        data-tone={state.tone} aria-expanded={open} aria-haspopup="dialog" aria-label={state.label}
        title={state.label}
        className={`inline-flex items-center gap-1 whitespace-nowrap border px-2 py-1 text-xs ${TONE[state.tone]}`}>
        {/* Narrow screens: the icon and its colour; the words from lg up (one line either way). */}
        <Zap className="h-3 w-3" aria-hidden="true" /><span className="hidden lg:inline">{state.label}</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-40 w-80 bg-white border border-gray-200 shadow-md"
          data-testid="autorun-chip-panel" role="dialog" aria-label="Auto-run on this sheet">
          <ul className="divide-y divide-gray-100">
            {on.map(c => (
              <li key={c.column} className="px-3 py-2 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm text-gray-900 truncate">{c.column}</p>
                  <p className={`text-xs ${c.pausedReason ? 'text-amber-700' : 'text-gray-500'}`}>
                    {c.pausedReason ? pauseLabel(c.pausedReason) : `On, ${autorunUsage(c)}`}
                  </p>
                </div>
                <button type="button" className="text-xs text-gray-700 underline flex-shrink-0"
                  onClick={() => { setOpen(false); autorun.open(c.column) }}>Settings</button>
              </li>
            ))}
          </ul>
          {choosing ? (
            <div className="px-3 py-2 border-t border-gray-100 space-y-1" data-testid="autorun-resume-choices">
              <p className="text-xs text-gray-600">Resume all. The rows added or changed while paused:</p>
              {RESUME.map(([rows, label, hint]) => (
                <button key={rows} type="button" className="w-full text-left px-2 py-1 hover:bg-gray-50"
                  onClick={() => { setOpen(false); void autorun.pauseAll(false, rows) }}>
                  <span className="block text-sm text-gray-900">{label}</span>
                  <span className="block text-xs text-gray-500">{hint}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="px-3 py-2 border-t border-gray-100 flex justify-end">
              <button type="button" className="btn-secondary text-xs"
                onClick={() => {
                  if (!anyGoing) { setChoosing(true); return }
                  setOpen(false)
                  void autorun.pauseAll(true)
                }}>
                {anyGoing ? 'Pause all auto-runs' : 'Resume all auto-runs'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
