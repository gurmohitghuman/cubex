import React, { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import type { EnrichRunStatus } from '@/utils/api'
import { TREG_APP_URL, TREG_TOPUP_URL, limitText, resetsAtText, spent, usd } from '@/lib/enrich-format'
import { MoneyInput } from './MoneyInput'
import { plainResumeWorks, type EnrichRunControls } from './useEnrichRun'

interface Props { status: EnrichRunStatus; run: EnrichRunControls }

const cents = (n: number) => Math.ceil(n * 100 - 1e-9) / 100
const btn = 'btn-secondary text-xs'
const external = (href: string, text: string) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className={`${btn} inline-flex items-center gap-1`}>
    {text}<ExternalLink className="h-3 w-3" />
  </a>
)

// "Raise to $[40] and resume": it suggests enough for the rows still to run at
// their per-row cap, and the new limit must leave room for at least one more
// row, or the run pauses again at once.
const RaiseAndResume: React.FC<{
  label: string; suggest: number; least: number; cap: number; busy: boolean; onRaise: (v: number) => void
}> = ({ label, suggest, least, cap, busy, onRaise }) => {
  const [value, setValue] = useState<number | null>(suggest)
  const short = value !== null && value + 1e-9 < least
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span>{label}</span>
        <MoneyInput value={suggest} fallback={null} label={label} onChange={setValue} />
        <button type="button" className="btn-primary text-xs" disabled={busy || value === null || short}
          onClick={() => value !== null && onRaise(value)} data-testid="enrich-raise-resume">Raise and resume</button>
      </div>
      {short && (
        <p className="text-xs">
          {cap > 0 ? `Each row can cost up to ${spent(cap)}, so it` : 'It'} needs at least {usd(cents(least))} to
          run another row.
        </p>
      )}
    </div>
  )
}

// A run that paused itself says why, with the fix in place: raise the run's
// limit, raise today's limit (or wait for the reset), top up at treg, check the
// key in Settings, or resume once treg is reachable again. A pause the user
// clicked needs no notice: the header's Resume is the fix.
export const PausedNotice: React.FC<Props> = ({ status, run }) => {
  const { tableId } = useParams<{ tableId: string }>()
  if (status.status !== 'paused' || !status.pauseReason) return null
  const cap = status.maxCostPerRowUsd ?? 0
  // Enough for the rows still to run, each at its per-row cap (an upper bound).
  const toFinish = Math.max(1, status.totalRows - status.processedRows) * cap
  const resume = (
    <button type="button" className={btn} disabled={run.busy} onClick={() => run.resume()} data-testid="enrich-resume">
      Resume
    </button>
  )
  let text = status.message ?? 'The run stopped.'
  let fix: React.ReactNode = resume
  switch (status.pauseReason) {
    case 'spend_limit': {
      const limit = status.spendLimitUsd ?? 0
      text = `The run reached its ${limitText(limit)} limit (${spent(status.spentUsd)} spent).`
      fix = <RaiseAndResume label="Raise the run limit to" suggest={cents(status.spentUsd + toFinish)}
        least={status.spentUsd + cap} cap={cap} busy={run.busy} onRaise={v => run.resume(v)} />
      break
    }
    case 'daily_limit': {
      const { limitUsd, usedTodayUsd } = status.dailyLimit
      const room = plainResumeWorks(status)
      // No per-row cap: treg's real charges reached the limit, and any cent above them lets a row run.
      const uncapped = status.maxCostPerRowUsd === null
      text = limitUsd === null
        ? 'The daily limit was reached. It is off now, so the run can go on.'
        : uncapped
          ? `Today's ${usd(limitUsd)} enrichment limit is reached (${spent(usedTodayUsd)} spent). It `
            + `${resetsAtText()}. This tool usually bills your own provider key, but what treg charges counts too.`
          : `Today's ${usd(limitUsd)} enrichment limit is reached. It ${resetsAtText()}.`
      const least = usedTodayUsd + (uncapped ? 0.01 : cap)
      fix = (
        <div className="space-y-2">
          {limitUsd !== null && !room && (
            <>
              <RaiseAndResume label="Raise the daily limit to" suggest={cents(Math.max(usedTodayUsd + toFinish, least))}
                least={least} cap={cap} busy={run.busy} onRaise={v => run.raiseDailyAndResume(v)} />
              <p className="text-xs">It stays at the new amount every day until you change it in Settings.</p>
            </>
          )}
          {room ? resume : <p className="text-xs">Or resume it after the reset.</p>}
        </div>
      )
      break
    }
    case 'balance':
      fix = <div className="flex flex-wrap gap-2">{external(TREG_TOPUP_URL, 'Top up at treg')}{resume}</div>
      break
    case 'auth':
    case 'no_key':
      fix = (
        <div className="flex flex-wrap gap-2">
          <Link to="/settings/http-enrichment" className={btn}>Open Settings</Link>{resume}
        </div>
      )
      break
    case 'dest_full':
      // The fix is in the sheet the rows go to: room first, then Resume.
      fix = (
        <div className="flex flex-wrap gap-2">
          {tableId && status.list?.destSheetId && (
            <Link to={`/table/${tableId}/${status.list.destSheetId}`} className={btn}>
              Open {status.list.destName ?? 'the sheet'}
            </Link>
          )}
          {resume}
        </div>
      )
      break
    case 'treg_cap':
    case 'team_rule':
      fix = <div className="flex flex-wrap gap-2">{external(TREG_APP_URL, 'Open treg')}{resume}</div>
      break
  }
  return (
    <div className="border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 space-y-2"
      data-testid="enrich-paused" data-reason={status.pauseReason}>
      <p><span className="font-medium">Paused.</span> {text}</p>
      {fix}
    </div>
  )
}
