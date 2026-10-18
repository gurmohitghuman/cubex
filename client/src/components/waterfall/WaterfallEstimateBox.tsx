import React from 'react'
import { Loader2 } from 'lucide-react'
import type { WaterfallEstimate } from '@/utils/api/waterfall'
import { formatCost } from '@/components/ai-modal/format'
import { pct } from './step-copy'

interface Props {
  estimate: WaterfallEstimate | null; loading: boolean; error: string | null; blocked: string | null
  nothingToRun?: boolean            // the error only says no row is left to run (not a failure)
}

const money = (v: number) => (v === 0 ? '$0' : formatCost(v))

// What the waterfall costs: on average and at most per row, for the rows in
// scope, and step by step how many rows reach it, what it costs when they do
// and how often it answers (this column's runs, treg's rate, or unknown).
export const WaterfallEstimateBox: React.FC<Props> = ({ estimate: e, loading, error, blocked, nothingToRun }) => (
  <div className="bg-gray-50 border border-gray-200 p-3 space-y-2 text-xs text-gray-700"
    data-testid="waterfall-estimate">
    {blocked ? <p className="text-gray-500">{blocked}</p>
      : !e ? (loading
        ? <p className="flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Estimating…</p>
        : <p className={nothingToRun ? 'text-gray-600' : 'text-red-700'}>{error ?? 'No estimate yet.'}</p>) : (
        <>
          <p className="text-sm text-gray-900">
            About <strong>{money(e.per_row.average_usd)}</strong> a row on average, at most{' '}
            <strong>{money(e.per_row.max_usd)}</strong>.
          </p>
          <p>
            {e.rows.toLocaleString()} rows: about {money(e.total.average_usd)}, at most {money(e.total.max_usd)}
            {e.run_limit_usd !== null ? ` (run limit ${money(e.run_limit_usd)})` : ''}.
            {loading && <Loader2 className="inline h-3 w-3 ml-1 animate-spin" />}
          </p>
          <table className="w-full">
            <thead><tr className="text-gray-500"><th className="text-left font-normal">Step</th>
              <th className="text-right font-normal">Reached</th><th className="text-right font-normal">Answers</th>
              <th className="text-right font-normal">Most</th></tr></thead>
            <tbody>
              {e.steps.map(s => (
                <tr key={s.id} className={s.on ? '' : 'text-gray-400'}>
                  <td className="truncate max-w-[10rem]">{s.label}</td>
                  <td className="text-right">{s.reach === null ? 'off' : pct(s.reach)}</td>
                  <td className="text-right" title={s.rate_from === 'history' ? "This column's earlier runs"
                    : s.rate_from === 'treg' ? "treg's observed rate" : 'Not known: counted as never'}>
                    {s.on ? pct(s.answer_rate) : ''}
                  </td>
                  <td className="text-right">{s.on ? money(s.max_usd) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {e.daily_limit?.limitUsd != null && (
            <p>
              Today&apos;s enrichment limit: {money(e.daily_limit.remainingUsd ?? 0)} left of{' '}
              {money(e.daily_limit.limitUsd)}.
            </p>
          )}
          {e.notes.map((n, i) => <p key={i} className="text-gray-500">{n}</p>)}
        </>
      )}
  </div>
)
