import React from 'react'
import type { CheckChoices, EmailAccept, ResultType } from '@/utils/api/waterfall'
import type { DraftInput } from './draft'
import { FormulaField } from './FormulaField'
import { Select } from '@/components/ui/Select'

interface Props {
  check: CheckChoices | null
  resultType: ResultType
  inputs: DraftInput[]
  onChange: (check: CheckChoices | null) => void
}

const ACCEPT: Array<[EmailAccept, string]> = [
  ['safest', 'Valid only'], ['balanced', 'Valid or catch-all'], ['wide', 'Valid, catch-all or risky'],
]

// A check on the value the step finds, before it counts: treg's email verify
// (a work email only; each check costs what treg charges) or a formula over
// {{value}} whose result is true. A value that fails is rejected and the next
// step runs.
export const CheckField: React.FC<Props> = ({ check, resultType, inputs, onChange }) => {
  const kind = check?.kind ?? ''
  const pick = (v: string) => onChange(v === 'verify' ? { kind: 'verify', accept: 'safest' }
    : v === 'formula' ? { kind: 'formula', formula: '' } : null)
  return (
    <div className="space-y-1.5" data-testid="waterfall-check">
      <label className="block space-y-1">
        <span className="meta-label">Check the answer (optional)</span>
        <Select className="w-full" value={kind} label="Check" onChange={pick} options={[
          { value: '', label: 'No check' },
          ...(resultType === 'email' ? [{ value: 'verify', label: 'Verify the email (treg, paid per check)' }] : []),
          { value: 'formula', label: 'A formula' },
        ]} />
      </label>
      {check?.kind === 'verify' && (
        <Select<string> className="w-full" value={check.accept} label="Accept"
          onChange={v => onChange({ kind: 'verify', accept: v as EmailAccept })}
          options={ACCEPT.map(([v, l]) => ({ value: v, label: l }))} />
      )}
      {check?.kind === 'formula' && (
        <FormulaField formula={check.formula} names={['value', ...inputs.map(i => i.key)]} label="Check formula"
          placeholder='{{value}}.endsWith("@" + {{domain}})'
          onChange={formula => onChange({ kind: 'formula', formula })} />
      )}
      {check && <p className="text-xs text-gray-500">A value that fails is rejected and the next step runs.</p>}
    </div>
  )
}
