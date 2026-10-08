import React, { useEffect, useState } from 'react'
import { ExternalLink, Loader2, Receipt } from 'lucide-react'
import { enrichAPI, type EnrichSpend } from '@/utils/api'
import { plural } from '@/lib/utils'
import { ENRICH_SPEND_WINDOWS } from '@/lib/constants'
import { TREG_APP_URL, spent } from '@/lib/enrich-format'

// "Spending on enrichments": what this Cubex's enrichments cost at treg over
// the last 7, 30 or 90 days, in total and per enrichment column, from Cubex's
// own record of each treg call. treg's dashboard has the bill itself, which
// also covers any other use of the same treg key.
export const EnrichmentSpendCard: React.FC = () => {
  const [days, setDays] = useState<number>(30)
  const [spend, setSpend] = useState<EnrichSpend | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setError(null)
    enrichAPI.spend(days)
      .then(s => { if (alive) setSpend(s) })
      .catch(e => { if (alive) setError(e?.response?.data?.error || "Couldn't read enrichment spending.") })
    return () => { alive = false }
  }, [days])

  const where = (c: EnrichSpend['columns'][number]) => (c.sheetId
    ? `${c.tableName} › ${c.sheetName} · ${c.column ?? 'Unnamed column'}` : `Deleted sheet · ${c.column ?? ''}`)

  return (
    <div className="card mb-6" data-testid="enrich-spend-card">
      <div className="p-6 border-b border-gray-200 flex items-center justify-between gap-3">
        <div className="flex items-center space-x-3">
          <div className="bg-cube-black p-2 rounded-sm"><Receipt className="h-5 w-5 text-white" /></div>
          <div>
            <h3 className="text-title text-gray-900">Spending on enrichments</h3>
            <p className="text-sm text-gray-600">What enrichments in this Cubex cost at treg, by column.</p>
          </div>
        </div>
        <select className="input w-auto py-1 text-sm" value={days} aria-label="Period"
          onChange={e => setDays(Number(e.target.value))}>
          {ENRICH_SPEND_WINDOWS.map(d => <option key={d} value={d}>Last {d} days</option>)}
        </select>
      </div>
      <div className="p-6 space-y-3">
        {error ? <p className="text-sm text-red-600">{error}</p> : !spend || spend.days !== days ? (
          <p className="text-sm text-gray-600 flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />Loading…
          </p>
        ) : spend.calls === 0 ? (
          <p className="text-sm text-gray-600">No enrichments ran in the last {plural(days, 'day')}.</p>
        ) : (
          <>
            <p className="text-sm text-gray-900" data-testid="enrich-spend-total">
              <span className="font-medium">Total {spent(spend.totalUsd)}</span>
              {' · '}{plural(spend.calls, 'call')} to treg
            </p>
            <ul className="divide-y divide-gray-100 border border-gray-200">
              {spend.columns.map((c, i) => (
                <li key={i}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 truncate text-gray-700" title={where(c)}>{where(c)}</span>
                  <span className="flex-shrink-0 text-gray-900">
                    {spent(c.spentUsd)} <span className="text-xs text-gray-500">· {plural(c.calls, 'call')}</span>
                  </span>
                </li>
              ))}
            </ul>
            {spend.otherColumns > 0 && (
              <p className="text-xs text-gray-600">
                {plural(spend.otherColumns, 'more column')}: {spent(spend.otherUsd)}
              </p>
            )}
          </>
        )}
        <p className="text-xs text-gray-600">
          From Cubex&apos;s record of each call, including calls in runs you stopped. Columns show under the name
          they had when they ran. treg&apos;s dashboard has the exact bill, with anything else that used this key.{' '}
          <a href={TREG_APP_URL} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 underline hover:no-underline">
            Open treg<ExternalLink className="h-3 w-3" />
          </a>
        </p>
      </div>
    </div>
  )
}
