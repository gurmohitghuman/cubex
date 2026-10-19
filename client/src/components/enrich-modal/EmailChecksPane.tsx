import React from 'react'
import { EMAIL_PATTERNS, type AcceptLevel, type EmailChecks } from './draft'
import { Select } from '@/components/ui/Select'

const LEVELS: Array<{ value: AcceptLevel; label: string; hint: string }> = [
  { value: 'safest', label: 'Valid only (safest)', hint: 'The checker confirmed the mailbox.' },
  { value: 'balanced', label: 'Valid or catch-all', hint: "Also domains that accept every address, so the checker can't confirm the mailbox." },
  { value: 'wide', label: 'Valid, catch-all or risky', hint: 'Also addresses the checker was unsure about.' },
]

export const acceptSummary = (level: AcceptLevel) => ({ safest: 'Valid only', balanced: 'Valid or catch-all', wide: 'Valid, catch-all or risky' }[level])

// Verified work email: which checker verdicts count, and the free guess
// (the address worked out from the name and domain) tried before any paid find.
export const EmailChecksPane: React.FC<{ value: EmailChecks; onChange: (v: EmailChecks) => void }> = ({ value, onChange }) => (
  <div className="space-y-3">
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium text-gray-700 mb-1">Accept</legend>
      {LEVELS.map(l => (
        <label key={l.value} className="flex items-start gap-2 text-sm text-gray-700">
          <input type="radio" name="enrich-accept" checked={value.accept === l.value} onChange={() => onChange({ ...value, accept: l.value })}
            className="mt-0.5 border-gray-300 text-cube-black focus:ring-black" />
          <span>{l.label}<span className="block text-xs text-gray-500">{l.hint}</span></span>
        </label>
      ))}
    </fieldset>
    <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={value.guess} onChange={e => onChange({ ...value, guess: e.target.checked })}
          className="border-gray-300 text-cube-black focus:ring-black" />
        Try a guess first
      </label>
      <Select className="py-1" value={value.pattern} disabled={!value.guess} label="Guess pattern"
        onChange={pattern => onChange({ ...value, pattern })}
        options={EMAIL_PATTERNS.map(p => ({ value: p, label: `${p}@domain` }))} />
    </div>
    <p className="text-xs text-gray-500">
      A guess costs only the check, which is free with some checkers. If a found address doesn&apos;t pass,
      it tries up to 3 finds per row, skipping providers already tried.
    </p>
  </div>
)
