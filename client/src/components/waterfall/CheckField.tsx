import React from 'react'
import type { CheckChoices, EmailAccept, ResultType } from '@/utils/api/waterfall'
import type { DraftInput } from './draft'
import { FormulaField } from './FormulaField'

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
        <select className="input w-full" value={kind} aria-label="Check" onChange={e => pick(e.target.value)}>
          <option value="">No check</option>
          {resultType === 'email' && <option value="verify">Verify the email (treg, paid per check)</option>}
          <option value="formula">A formula</option>
        </select>
      </label>
      {check?.kind === 'verify' && (
        <select className="input w-full" value={check.accept} aria-label="Accept"
          onChange={e => onChange({ kind: 'verify', accept: e.target.value as EmailAccept })}>
          {ACCEPT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
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
