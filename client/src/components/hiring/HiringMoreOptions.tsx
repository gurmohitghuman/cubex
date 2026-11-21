import React from 'react'
import { AccordionSection } from '@/components/AccordionSection'
import { HIRING_EMPLOYMENT_TYPES, HIRING_SENIORITY_LEVELS } from '@/lib/hiring'

// The create dialog's "More options" (server lib/hiring/filters.ts): words
// that put roles first, words and levels that leave roles out, and chosen
// companies. A table made with any of them searches the one job index that
// takes them; the server reads the text fields' commas as separate words.
export interface HiringOptions {
  descriptionWords: string; leaveOutDescriptionWords: string; leaveOutTitleWords: string
  seniority: string[]; employmentTypes: string[]; companies: string
}
export const NO_HIRING_OPTIONS: HiringOptions = {
  descriptionWords: '', leaveOutDescriptionWords: '', leaveOutTitleWords: '', seniority: [], employmentTypes: [],
  companies: '',
}
export const hiringOptionsSet = (o: HiringOptions): number =>
  Object.values(o).filter(v => (Array.isArray(v) ? v.length > 0 : v.trim() !== '')).length

export const HiringMoreOptions: React.FC<{ value: HiringOptions; onChange: (v: HiringOptions) => void }> =
  ({ value, onChange }) => {
    const set = <K extends keyof HiringOptions>(k: K, v: HiringOptions[K]) => onChange({ ...value, [k]: v })
    const toggle = (k: 'seniority' | 'employmentTypes', item: string) =>
      set(k, value[k].includes(item) ? value[k].filter(x => x !== item) : [...value[k], item])
    const n = hiringOptionsSet(value)
    const text = (k: 'descriptionWords' | 'leaveOutDescriptionWords' | 'leaveOutTitleWords' | 'companies',
      label: string, placeholder: string, hint?: string) => (
      <div>
        <div className="text-sm font-medium text-gray-900 mb-1">{label}</div>
        <input className="input w-full" value={value[k]} onChange={e => set(k, e.target.value)} aria-label={label}
          placeholder={placeholder} />
        {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
      </div>
    )
    const boxes = (k: 'seniority' | 'employmentTypes', label: string, items: readonly string[]) => (
      <div role="group" aria-label={label}>
        <div className="text-sm font-medium text-gray-900 mb-1">{label}</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {items.map(item => (
            <label key={item} className="flex items-center gap-1.5 text-sm text-gray-700">
              <input type="checkbox" checked={value[k].includes(item)} onChange={() => toggle(k, item)} />{item}
            </label>
          ))}
        </div>
      </div>
    )
    return (
      <div data-testid="hiring-more-options">
        <AccordionSection title="More options" summary={n ? `${n} set` : undefined}>
          {text('descriptionWords', 'Roles that mention these words come first', 'Salesforce, outbound',
            'Commas between words. Roles without them are still found.')}
          {text('leaveOutDescriptionWords', 'Leave out roles whose description mentions', 'security clearance')}
          {text('leaveOutTitleWords', 'Leave out roles whose title has', 'intern, contract')}
          {boxes('seniority', 'Seniority', HIRING_SENIORITY_LEVELS)}
          {boxes('employmentTypes', 'Employment type', HIRING_EMPLOYMENT_TYPES)}
          {text('companies', 'Only roles at these companies', 'ramp.com, ford.com', 'Websites, commas between them.')}
        </AccordionSection>
      </div>
    )
  }
