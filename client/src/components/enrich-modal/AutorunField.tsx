import React from 'react'
import { MoneyInput } from './MoneyInput'
import { webhookWarning } from '@/components/autorun/autorun-copy'
import { AUTORUN_DEFAULT_DAILY_CAP_USD } from '@/lib/constants'
import type { EnrichDraft } from './draft'

interface Props {
  draft: EnrichDraft
  update: (patch: Partial<EnrichDraft>) => void
  hasWebhook: boolean
  dailyLimitUsd: number | null
  // The provider that bills this tool directly (the team's own key): no cap applies.
  billedBy: string | null
}

// Set up's auto-run choice: once the full run starts (not the test on a few
// rows), the column fills new rows and rows whose inputs get filled by itself,
// once per row, under "Only run if" and a daily cap for this column
// (enrich-modal/autorun-save.ts, server services/autorun-settings.ts).
export const AutorunField: React.FC<Props> = ({ draft, update, hasWebhook, dailyLimitUsd, billedBy }) => {
  const fallback = Math.min(AUTORUN_DEFAULT_DAILY_CAP_USD, dailyLimitUsd ?? AUTORUN_DEFAULT_DAILY_CAP_USD)
  return (
    <div className="space-y-1.5" data-testid="enrich-autorun">
      <label className="flex items-start gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={draft.autoRun} onChange={e => update({ autoRun: e.target.checked })}
          className="mt-0.5 border-gray-300 text-cube-black focus:ring-black" />
        <span>
          Auto-run: fill new rows and rows whose inputs get filled
          <span className="block text-xs text-gray-500">
            Once per row, when &quot;Only run if&quot; passes. Rows already enriched aren&apos;t run again when you
            edit them. It turns on with the full run, not the test.
          </span>
        </span>
      </label>
      {draft.autoRun && (
        <div className="ml-6 space-y-1.5">
          {billedBy ? (
            <p className="text-xs text-gray-600">No daily cap: {billedBy} bills these calls directly.</p>
          ) : (
            <label className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
              Cap for this column
              <MoneyInput value={draft.autoRunCapUsd} fallback={fallback} label="Auto-run daily cap"
                onChange={v => update({ autoRunCapUsd: v })} />
              a day
            </label>
          )}
          {hasWebhook && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 px-2.5 py-1.5"
              data-testid="enrich-autorun-webhook">
              {webhookWarning('enrichment', dailyLimitUsd, !!billedBy)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
