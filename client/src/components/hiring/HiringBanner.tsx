import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Briefcase } from 'lucide-react'
import type { SheetData } from '@/utils/api/types'
import { hiringAPI, type HiringCheck, type HiringView } from '@/utils/api/hiring'
import { HIRING_CHECK_POLL_MS, checkDay } from '@/lib/hiring'
import { HiringCheckDialog } from './HiringCheckDialog'

// Above the grid of a hiring table's three sheets: what it searches for, its
// sheets, Check now / Check again (the estimate first), and the last check:
// still going (looked at every few seconds until it ends), done (what it
// found) or stopped (why). A new table opens on its first check's estimate.
const plural = (n: number, w: string, ws = `${w}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? w : ws}`
const going = (c: HiringCheck | undefined) => c?.stage === 'searching' || c?.stage === 'summarizing'

function checkWords(c: HiringCheck): string {
  if (c.stage === 'searching') return `Checking: searching ${plural(c.searches, 'role title')}…`
  if (c.stage === 'summarizing') return 'Checking: summing up the roles per company…'
  const found = `${plural(c.rolesAdded, 'new role')}, ${plural(c.companiesNew, 'new company', 'new companies')}`
    + (c.since ? `, ${plural(c.companiesHiringMore, 'company', 'companies')} hiring more` : '')
  if (c.stage === 'done') return `Last check, ${checkDay(c.label)}: ${found}.`
  return `The last check, ${checkDay(c.label)}, stopped${c.problems[0] ? `: ${c.problems[0]}` : '.'}`
}

export const HiringBanner: React.FC<{ v: HiringView; sheetId: string; onChanged: () => void }> =
  ({ v, sheetId, onChanged }) => {
    const navigate = useNavigate()
    const location = useLocation()
    const [checking, setChecking] = useState(false)
    const last = v.checks[0]
    // A new table opens on its first check's estimate (the dialog that made it says so).
    useEffect(() => {
      if ((location.state as { hiringEstimate?: string } | null)?.hiringEstimate !== v.id) return
      navigate(location.pathname, { replace: true, state: null })
      setChecking(true)
    }, [location.state, location.pathname, navigate, v.id])
    // A check going: look again until it ends, then reload the sheet.
    const stage = useRef(last?.stage)
    stage.current = last?.stage
    useEffect(() => {
      if (!going(last)) return
      const timer = setInterval(() => {
        hiringAPI.get(v.id).then(now => { if (now.checks[0]?.stage !== stage.current) onChanged() })
          .catch(() => { /* the next look */ })
      }, HIRING_CHECK_POLL_MS)
      return () => clearInterval(timer)
    }, [last, v.id, onChanged])
    const close = useCallback(() => setChecking(false), [])

    const sheets = [['Companies', v.companiesSheetId], ['Roles', v.rolesSheetId], ['Searches', v.searchesSheetId]]
    const where = [v.place, v.country].filter(Boolean).join(', ')
    return (
      <div className="mx-4 mt-3 mb-1 border border-gray-200 bg-white rounded-lg px-4 py-3" data-testid="hiring-banner">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Briefcase className="h-4 w-4 text-gray-900" />
          <span className="text-sm font-semibold text-gray-900">Companies hiring: {v.roles.join(', ')}</span>
          <span className="text-xs text-gray-500">
            {where || 'any country'}{v.postedWithinDays ? `, posted in the last ${v.postedWithinDays} days` : ''}
          </span>
          <span className="flex items-center gap-1 text-xs">
            {sheets.map(([name, id]) => id && (
              <button key={name} type="button" disabled={id === sheetId} className={`px-2 py-0.5 rounded ${
                id === sheetId ? 'bg-gray-100 text-gray-900' : 'text-gray-600 underline'}`}
                onClick={() => navigate(`/table/${v.tableId}/${id}`)}>{name}</button>
            ))}
          </span>
          <span className="flex-1" />
          <button type="button" className="btn-secondary text-xs px-3 py-1 disabled:opacity-50"
            disabled={going(last)} onClick={() => setChecking(true)} data-testid="hiring-check">
            {last ? 'Check again…' : 'Check now…'}</button>
        </div>
        <div className={`text-xs mt-2 ${last?.stage === 'stopped' ? 'text-red-600' : 'text-gray-600'}`}
          data-testid="hiring-last-check">
          {last ? checkWords(last) : 'Not checked yet: Check now shows what a check costs before it searches.'}
          {last?.stage === 'done' && last.since && last.companiesHiringMore + last.companiesNew > 0
            && ' Filter New roles above 0 for the companies with new roles.'}
        </div>
        {last?.stage === 'done' && last.problems.map(p => <p key={p} className="text-xs text-gray-500">{p}</p>)}
        {checking && <HiringCheckDialog v={v} onClose={close} onStarted={onChanged} />}
      </div>
    )
  }

// The banner when the open sheet is one of a hiring table's.
export const SheetHiringBanner: React.FC<{ sheetData: SheetData | null; onChanged: () => void }> =
  ({ sheetData, onChanged }) => {
    const v = sheetData?.data.hiring
    const sheetId = sheetData?.sheet?.id
    if (!v || !sheetId) return null
    return <HiringBanner key={v.id} v={v} sheetId={sheetId} onChanged={onChanged} />
  }
