import React from 'react'
import type { EnrichAnswerInfo } from '@/utils/api'
import { stepCost, stepText, triedCost, triedText } from './answer-copy'

type SectionProps = { title: string; children: React.ReactNode; testId?: string }
const Section: React.FC<SectionProps> = ({ title, children, testId }) => (
  <section data-testid={testId}>
    <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1.5">{title}</h4>
    {children}
  </section>
)

// An enrichment row's steps: each call it made (the ledger, matched by the
// row's stable id, so a sort never shows another row's), with its call id
// and cost, then the providers treg tried for the final answer.
export const AnswerSteps: React.FC<{ e: EnrichAnswerInfo }> = ({ e }) => (
  <>
    {e.calls.length > 0 && (
      <Section title="Steps" testId="answer-steps">
        <ol className="space-y-1.5 list-decimal pl-5 marker:text-gray-500">
          {e.calls.map((c, i) => (
            <li key={`${c.attempt}-${i}`} className="text-sm" data-testid="answer-step">
              <div className="flex items-start justify-between gap-3">
                <span className="text-gray-800 min-w-0 break-words">{stepText(c, e.toolName)}</span>
                <span className="text-xs text-gray-600 whitespace-nowrap">{stepCost(c)}</span>
              </div>
              {c.callId && <p className="text-[11px] text-gray-500 font-mono break-all">call {c.callId}</p>}
            </li>
          ))}
        </ol>
      </Section>
    )}
    {e.tried.length > 0 && (
      <Section title={e.calls.length > 1 ? 'Providers treg tried for the final answer' : 'Providers treg tried'}
        testId="answer-tried">
        <ul className="space-y-1">
          {e.tried.map((t, i) => (
            <li key={i} className="flex items-start justify-between gap-3 text-sm">
              <span className="text-gray-700 min-w-0 break-words">{triedText(t)}</span>
              <span className="text-xs text-gray-600 whitespace-nowrap">{triedCost(t)}</span>
            </li>
          ))}
        </ul>
      </Section>
    )}
  </>
)

export { Section }
