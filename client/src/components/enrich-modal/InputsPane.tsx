import React, { useState } from 'react'
import { Check } from 'lucide-react'
import type { EnrichToolDetail, EnrichToolInput } from '@/utils/api'
import type { InputBinding } from './draft'
import { inputLabel } from './labels'
import { boundInputs, identityText, setAvailable } from './readiness'
import { InputRow } from './InputRow'

// Inputs that take a bare domain (the server's DOMAIN_INPUT_NAMES): "Clean up
// to a domain" turns https://www.stripe.com/about into stripe.com.
const DOMAIN_INPUTS = new Set(['domain', 'company_domain', 'website', 'company_website', 'url_domain'])

interface Props {
  tool: EnrichToolDetail
  bindings: Record<string, InputBinding>
  setBinding: (name: string, binding: InputBinding | null) => void
  columns: string[]
  cleanDomains: boolean
  setCleanDomains: (v: boolean) => void
  // A list job asks one provider: more inputs widen the choice, not the tries.
  addsRows?: boolean
}

export const InputsPane: React.FC<Props> = ({
  tool, bindings, setBinding, columns, cleanDomains, setCleanDomains, addsRows,
}) => {
  const [showMore, setShowMore] = useState(false)
  const row = (input: EnrichToolInput) => (
    <InputRow key={input.name} input={input} label={inputLabel(input.name, tool.capability)}
      binding={bindings[input.name]}
      columns={columns} onChange={b => setBinding(input.name, b)} />
  )
  const sent = boundInputs(bindings, columns)
  const known = new Set(tool.inputs.map(i => i.name))
  const usesDomain = tool.inputs.some(i => DOMAIN_INPUTS.has(i.name) && bindings[i.name]?.kind === 'column')

  // Waterfalls: every identity key, since sending all you have lets more
  // providers try; then the optional filters.
  if (tool.identitySets) {
    const ready = tool.identitySets.filter(set => setAvailable(set, sent, tool.derive, known))
    const keys = tool.inputs.filter(i => !i.filter), filters = tool.inputs.filter(i => i.filter && i.name !== 'limit')
    return (
      <div className="space-y-3">
        <p className={`text-xs ${ready.length ? 'text-gray-700' : 'text-gray-500'} flex items-start gap-1`}>
          {ready.length > 0 && <Check className="h-3.5 w-3.5 mt-px flex-shrink-0" />}
          <span>
            {ready.length > 0
              ? (addsRows ? 'Ready. More inputs let you pick from more providers.'
                : 'Ready. Each other input you map lets more providers try.')
              : `Needs ${identityText(tool)}. Each other input you map lets more providers try.`}
          </span>
        </p>
        <div className="space-y-2">{keys.map(row)}</div>
        {filters.length > 0 && (
          <div className="space-y-2">
            <h4 className="meta-label">Filters (optional)</h4>
            {filters.map(row)}
          </div>
        )}
        {usesDomain && <CleanDomains value={cleanDomains} onChange={setCleanDomains} />}
      </div>
    )
  }

  // Single tools: required inputs first; the rest behind "More options". A
  // list job's page size (limit) is its results per row, set below.
  const shown = tool.inputs.filter(i => !(addsRows && i.name === 'limit'))
  const required = shown.filter(i => i.required)
  const optional = shown.filter(i => !i.required)
  const visible = showMore ? optional : optional.filter(i => bindings[i.name])
  return (
    <div className="space-y-3">
      {shown.length === 0 && <p className="text-xs text-gray-500">This tool takes no inputs.</p>}
      <div className="space-y-2">{required.map(row)}{visible.map(row)}</div>
      {optional.length > visible.length && (
        <button type="button" onClick={() => setShowMore(true)}
          className="text-xs text-gray-600 underline hover:no-underline">
          More options ({optional.length - visible.length})
        </button>
      )}
      {usesDomain && <CleanDomains value={cleanDomains} onChange={setCleanDomains} />}
    </div>
  )
}

const CleanDomains: React.FC<{ value: boolean; onChange: (v: boolean) => void }> = ({ value, onChange }) => (
  <label className="flex items-start gap-2 text-sm text-gray-700">
    <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)}
      className="mt-0.5 border-gray-300 text-cube-black focus:ring-black" />
    <span>
      Clean up to a domain
      <span className="block text-xs text-gray-500">
        https://www.stripe.com/about becomes stripe.com, so more providers match it.
      </span>
    </span>
  </label>
)

// The accordion's one-line summary: the columns in use ("Name, Website").
export function inputsSummary(bindings: Record<string, InputBinding>): string {
  const cols = [...new Set(Object.values(bindings).map(b => (b.kind === 'column' ? b.column : 'fixed value')))]
  return cols.length ? cols.join(', ') : 'Nothing mapped yet'
}
