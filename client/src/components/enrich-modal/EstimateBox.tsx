import React from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, Loader2 } from 'lucide-react'
import type { EnrichEstimate, TregBalance } from '@/utils/api'
import { plural } from '@/lib/utils'
import { TREG_TOPUP_URL, limitText, resetsAtText, spent, usd } from '@/lib/enrich-format'

interface Props {
  estimate: EnrichEstimate | null
  loading: boolean
  error: string | null
  rows: number | null
  balance: TregBalance | null
  spendLimit: number | null
  // What a miss costs with the providers picked, in a sentence.
  missNote: string
  ownKeys: boolean
  // Why there's nothing to estimate yet (no provider can use the inputs…).
  blocked: string | null
  // A tool with no listed price, and the provider that bills it (the team's
  // own key at treg).
  unpriced: boolean
  // A priced single tool the team runs on its own key at treg.
  ownKeySingle: boolean
  ownKeyProvider: string
  // The heading's words for the rows ("Estimated for the other 1,199 rows").
  label?: string
  // A list job's destination sheet, for "May add up to N rows to People".
  listDest?: string | null
}

// Amber from this share of the row limit on.
const NEAR_FULL = 0.9

function ListRowsLine({ list, dest }: { list: NonNullable<EnrichEstimate['list']>; dest: string }) {
  const after = list.destRows + list.addUpTo
  const room = Math.max(0, list.maxRows - list.destRows)
  const near = after > list.maxRows * NEAR_FULL
  return (
    <p className={near ? 'text-amber-800' : ''} data-testid="enrich-list-estimate">
      May add up to {plural(list.addUpTo, 'row')} to {dest} ({list.perRow.toLocaleString()} per row).
      {after > list.maxRows
        ? ` ${dest} has room for ${plural(room, 'more row')}; the run pauses when it's full.`
        : near ? ` That brings ${dest} close to its ${list.maxRows.toLocaleString()}-row limit.` : ''}
    </p>
  )
}

const GRAY = 'bg-gray-50 border border-gray-200'
const AMBER = 'bg-amber-50 border-amber-200 text-amber-900'

// The AI drawer's gray estimate box, for treg's prices: a range for the rows
// (every row found by the cheapest provider, up to every row spending its
// whole per-row limit), the balance and today's limit. Amber when the run
// could spend more than the balance.
export const EstimateBox: React.FC<Props> = ({
  estimate, loading, error, rows, balance, spendLimit, missNote, ownKeys, blocked, unpriced, ownKeySingle,
  ownKeyProvider, label, listDest,
}) => {
  if (unpriced || ownKeySingle) {
    return (
      <div className="bg-gray-50 border border-gray-200 p-3 text-xs text-gray-700" data-testid="enrich-estimate">
        {unpriced ? 'This tool has no price at treg: it runs' : 'This runs'} on your own {ownKeyProvider} key
        {unpriced ? ' there' : ' at treg'}, so {ownKeyProvider} bills you directly, not your treg balance. Cubex
        can&apos;t estimate it, and the daily limit doesn&apos;t cover it.
      </div>
    )
  }
  if (blocked) {
    return <div className={`${GRAY} p-3 text-xs text-gray-700`} data-testid="enrich-estimate">{blocked}</div>
  }
  if (!estimate || rows === null) {
    return (
      <div className={`${GRAY} p-3 text-xs text-gray-600 flex items-center gap-2`} data-testid="enrich-estimate">
        {error ? <span>{error}</span>
          : <><Loader2 className="h-3 w-3 animate-spin" /><span>Estimating the cost…</span></>}
      </div>
    )
  }
  const { lowUsd, highUsd } = estimate.estimate
  const high = spendLimit !== null ? Math.min(highUsd, spendLimit) : highUsd
  const overBalance = !!balance && high > balance.balanceUsd + 1e-9
  const limit = estimate.dailyLimit
  const overDaily = limit.remainingUsd !== null && high > limit.remainingUsd + 1e-9

  return (
    <div className={`border p-3 text-xs space-y-1 ${overBalance ? AMBER : 'bg-gray-50 border-gray-200 text-gray-700'}`}
      data-testid="enrich-estimate">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-cube-black">{label ?? `Estimated for ${plural(rows, 'row')}`}</span>
        <span className="font-medium text-cube-black flex items-center gap-1.5">
          {loading && <Loader2 className="h-3 w-3 animate-spin text-gray-400" />}
          {spent(lowUsd)} to {spent(highUsd)}
        </span>
      </div>
      <p>Most rows cost less than the high end. {missNote}</p>
      {estimate.list && <ListRowsLine list={estimate.list} dest={listDest || 'the other sheet'} />}
      {spendLimit !== null && spendLimit < highUsd && (
        <p>The run pauses at {limitText(spendLimit)}, your limit for this run.</p>
      )}
      {ownKeys && <p>Providers that use your own key at treg bill you directly, outside these numbers.</p>}
      {balance && (overBalance ? (
        <p className="font-medium">
          This could cost more than your treg balance ({usd(balance.balanceUsd)}).{' '}
          <a href={TREG_TOPUP_URL} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 underline hover:no-underline">
            Top up at treg<ExternalLink className="h-3 w-3" />
          </a>{' '}or lower the limits.
        </p>
      ) : (
        <p>
          Your treg balance: {usd(balance.balanceUsd)}
          {balance.onHoldUsd > 0 ? ` (${usd(balance.onHoldUsd)} on hold)` : ''}
        </p>
      ))}
      <p className={overDaily ? 'text-amber-800' : ''} data-testid="enrich-daily-line">
        {limit.limitUsd === null
          ? 'No daily limit is set for enrichments.'
          : `Daily limit ${usd(limit.limitUsd)}, ${spent(limit.remainingUsd ?? 0)} left today. ${overDaily
            ? `This run could reach it and then pause until it ${resetsAtText()}.`
            : 'The run pauses if it reaches it.'}`}{' '}
        <Link to="/settings/http-enrichment" className="underline hover:no-underline">Change</Link>
      </p>
    </div>
  )
}
