import React from 'react'
import { THE_COMPANY_CHOICES, type TheCompany } from '@/lib/cleaners'

const LABEL = 'block text-xs font-medium text-gray-700 mb-1'
const RADIO = 'border-gray-300 text-cube-black focus:ring-black'
const CHOICE = 'flex items-center gap-2 text-sm text-gray-700'

interface NameInputProps {
  part: 'first' | 'last'
  partOnly: boolean
  onChange: (partOnly: boolean) => void
}

// The first- and last-name cleaners' option: the column holds full names
// (read for the part the cleaner gives) or only that part.
export const CleanNameInputOption: React.FC<NameInputProps> = ({ part, partOnly, onChange }) => (
  <fieldset className="space-y-1.5" data-testid="clean-name-input">
    <legend className={LABEL}>The column holds</legend>
    {[false, true].map(only => (
      <label key={String(only)} className={CHOICE}>
        <input type="radio" name="clean-name-input" checked={partOnly === only} onChange={() => onChange(only)}
          className={RADIO} />
        {only ? `${part === 'first' ? 'First' : 'Last'} names only` : 'Full names'}
      </label>
    ))}
    <p className="text-xs text-gray-500">
      {part === 'first'
        ? 'Pick First names only when there is nothing else in it: Dr. Sarah then gives Sarah, not a blank.'
        : 'Pick Last names only when there is nothing else in it: SMITH JONES then gives Smith Jones, not Jones.'}
    </p>
  </fieldset>
)

interface TheCompanyProps { value: TheCompany; onChange: (value: TheCompany) => void }

// The company name cleaner's option: what "The ... Company" becomes.
export const CleanTheCompanyOption: React.FC<TheCompanyProps> = ({ value, onChange }) => (
  <fieldset className="space-y-1.5" data-testid="clean-the-company">
    <legend className={LABEL}>The … Company</legend>
    {THE_COMPANY_CHOICES.map(c => (
      <label key={c.id} className={CHOICE}>
        <input type="radio" name="clean-the-company" checked={value === c.id} onChange={() => onChange(c.id)}
          className={RADIO} />
        {c.label}
        <span className="text-gray-500">{c.example}</span>
      </label>
    ))}
    <p className="text-xs text-gray-500">
      Keep it for companies always named with The and Company. Inc, LLC and other legal endings go either way.
    </p>
  </fieldset>
)
