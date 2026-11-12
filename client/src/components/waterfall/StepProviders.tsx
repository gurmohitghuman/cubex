import React, { useEffect, useState } from 'react'
import { enrichAPI, type EnrichToolAccess, type EnrichToolDetail } from '@/utils/api'
import { AccordionSection } from '@/components/AccordionSection'
import { ProvidersPane, providersSummary, providerStates } from '@/components/enrich-modal/ProvidersPane'

export interface ProviderChoices { providerOrder?: string[]; skipProviders?: string[]; stopAtFirst?: boolean }

interface Props {
  toolId: string
  tool?: EnrichToolDetail | null   // already loaded by the step; else loaded here
  sent: Set<string>                // the tool inputs the step fills
  order: string[]
  skip: string[]
  stopAtFirst?: boolean            // left out for an email check: it has no "Stop after the first provider"
  title?: string
  onChange: (patch: ProviderChoices) => void
}

// The providers a waterfall's find step or email check asks, listed as the Enrichment drawer lists them: switch
// one off, or put some first. Only a tool that asks providers in turn has the list. The step's lists change only
// when the user changes them, so a name the list doesn't show stays as it was.
export const StepProviders: React.FC<Props> = ({ toolId, tool: given, sent, order, skip, stopAtFirst, title,
  onChange }) => {
  const [loaded, setLoaded] = useState<EnrichToolDetail | null>(null)
  const [access, setAccess] = useState<EnrichToolAccess | null>(null)
  const tool = given ?? loaded

  useEffect(() => {
    if (given !== undefined) return
    let alive = true
    enrichAPI.tool(toolId).then(t => { if (alive) setLoaded(t) }).catch(() => {})
    return () => { alive = false }
  }, [toolId, given])
  useEffect(() => {
    let alive = true
    setAccess(null)
    enrichAPI.access(toolId).then(a => { if (alive) setAccess(a) }).catch(() => {})
    return () => { alive = false }
  }, [toolId])

  if (!tool || tool.kind !== 'waterfall' || !tool.providers?.length) return null
  const { rows, stateOf } = providerStates({ tool, access, order, skip, sent })
  return (
    <div data-testid="waterfall-providers">
      <AccordionSection title={title ?? 'Providers'} summary={providersSummary(rows, stateOf)}>
        <ProvidersPane tool={tool} access={access} order={order} skip={skip} stopAtFirst={stopAtFirst} sent={sent}
          update={onChange} />
      </AccordionSection>
    </div>
  )
}
