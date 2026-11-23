import React from 'react'
import { AccordionSection } from '@/components/AccordionSection'
import { HIRING_EMPLOYMENT_TYPES, HIRING_MAX_MIN_ROLES, HIRING_SENIORITY_LEVELS } from '@/lib/hiring'

// The create dialog's "More options" (server lib/hiring/filters.ts): words a
// role's description or title must have or not have, levels, employment types
// and chosen companies. A table made with any of them searches the one job index that
// takes them; the server reads the text fields' commas as separate words. Then
// "On Companies" (company-filters.ts): which companies get a row on Companies,
// by their number of matching roles and by website; the search stays the same.
export interface HiringOptions {
  descriptionWords: string; leaveOutDescriptionWords: string; leaveOutTitleWords: string
  seniority: string[]; employmentTypes: string[]; companies: string
  minRoles: string; leaveOutCompanies: string
}
export const NO_HIRING_OPTIONS: HiringOptions = {
  descriptionWords: '', leaveOutDescriptionWords: '', leaveOutTitleWords: '', seniority: [], employmentTypes: [],
  companies: '', minRoles: '1', leaveOutCompanies: '',
}
// At least 1 matching role (or none written) is every company: not set.
export const hiringOptionsSet = (o: HiringOptions): number => Object.entries(o).filter(([k, v]) => (Array.isArray(v)
  ? v.length > 0 : k === 'minRoles' ? !['', '1'].includes(v.trim()) : v.trim() !== '')).length

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
          {text('descriptionWords', 'Only roles whose description mentions any of these words', 'Salesforce, outbound',
            'Commas between words.')}
          {text('leaveOutDescriptionWords', 'Leave out roles whose description mentions', 'security clearance')}
          {text('leaveOutTitleWords', 'Leave out roles whose title has', 'intern, contract')}
          {boxes('seniority', 'Seniority', HIRING_SENIORITY_LEVELS)}
          {boxes('employmentTypes', 'Employment type', HIRING_EMPLOYMENT_TYPES)}
          {text('companies', 'Only roles at these companies', 'ramp.com, ford.com', 'Websites, commas between them.')}
          <div role="group" aria-label="On Companies" className="border-t border-gray-100 pt-3 space-y-3">
            <div className="text-xs font-semibold text-gray-500">On Companies, after the search</div>
            <label className="flex flex-wrap items-center gap-2 text-sm font-medium text-gray-900">
              Companies with at least
              <input className="input w-20" type="number" min={1} max={HIRING_MAX_MIN_ROLES} value={value.minRoles}
                onChange={e => set('minRoles', e.target.value)} aria-label="Companies with at least N matching roles" />
              matching roles
            </label>
            <div>
              <div className="text-sm font-medium text-gray-900 mb-1">Leave these companies out of Companies</div>
              <textarea className="input w-full h-16" value={value.leaveOutCompanies}
                onChange={e => set('leaveOutCompanies', e.target.value)} placeholder="acme.com, ramp.com"
                aria-label="Leave these companies out of Companies" />
              <p className="text-xs text-gray-500 mt-1">Websites, commas or lines between them.</p>
            </div>
            <p className="text-xs text-gray-500">
              Companies with fewer roles, and the companies you leave out, get no row on Companies. Their roles are
              still searched and paid for, and stay in Roles.
            </p>
          </div>
        </AccordionSection>
      </div>
    )
  }
