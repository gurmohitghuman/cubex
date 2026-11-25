import React from 'react'
import { AUTORUN_MAX_START_DELAY_S } from '@/lib/constants'

// The auto-run dialog's start delay (server services/autorun-pick.ts): a row waits this many seconds after its
// last change before it runs, so one still being filled in (by hand, a webhook in parts, another column) runs once
// it is done. Empty is 0 (at once).
export const delayOf = (text: string): number => (text.trim() === '' ? 0 : Number(text))
export const delayProblem = (text: string): string | null => {
  const s = delayOf(text)
  return Number.isInteger(s) && s >= 0 && s <= AUTORUN_MAX_START_DELAY_S ? null
    : `The wait must be a whole number of seconds from 0 to ${AUTORUN_MAX_START_DELAY_S}.`
}

export const AutorunDelayField: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
  const problem = delayProblem(value)
  return (
    <div className="space-y-1">
      <label className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
        Wait
        <input className={`input w-20 py-1 ${problem ? '!border-red-300' : ''}`} inputMode="numeric" value={value}
          aria-label="Seconds to wait" onChange={e => onChange(e.target.value.replace(/[^\d]/g, ''))} />
        seconds after a row&apos;s last change before running it
      </label>
      {problem ? <p className="text-xs text-red-600">{problem}</p> : (
        <p className="text-xs text-gray-500">
          0 runs it at once. A row still being filled in runs once it&apos;s done.
        </p>
      )}
    </div>
  )
}
