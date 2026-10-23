import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Globe, MessageSquare, Radar, X } from 'lucide-react'
import type { SheetData } from '@/utils/api/types'
import type { AiVisibilityView } from '@/utils/api/ai-visibility'
import { AskEngines } from './AskEngines'
import { BrandsEditor } from './BrandsEditor'
import { CheckAgain } from './CheckAgain'
import { LastCheck } from './LastCheck'

// Above the grid of an AI visibility table's questions sheet: asking the
// engines (after an estimate) and, weeks later, checking again, how to read
// the columns, the cited sites, and the brands looked for. Hidden (remembered in this browser only), it folds
// into one line that opens it again: it's where the asking is.
const hiddenKey = (sheetId: string) => `cubex-ai-visibility-guide-hidden-${sheetId}`

const Step: React.FC<{ icon: React.ReactNode; title: string; action?: React.ReactNode; children: React.ReactNode }> =
  ({ icon, title, action, children }) => (
    <div className="border border-gray-100 bg-gray-50 rounded p-3 flex flex-col">
      <div className="flex items-center gap-2 text-sm font-medium text-gray-900">{icon}<span>{title}</span></div>
      <div className="text-xs text-gray-600 mt-1 flex-1">{children}</div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )

export const AiVisibilityGuide: React.FC<{ v: AiVisibilityView; onChanged: () => void }> = ({ v, onChanged }) => {
  const navigate = useNavigate()
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(hiddenKey(v.questionsSheetId)) === '1' } catch { return false }
  })
  const remember = (on: boolean) => {
    try {
      if (on) localStorage.setItem(hiddenKey(v.questionsSheetId), '1')
      else localStorage.removeItem(hiddenKey(v.questionsSheetId))
    } catch { /* for this visit only */ }
    setHidden(on)
  }
  if (hidden) {
    return (
      <div className="mx-4 mt-2 mb-1 flex items-center gap-2 text-xs text-gray-600">
        <Radar className="h-3.5 w-3.5" />
        <button type="button" className="underline" onClick={() => remember(false)} data-testid="ai-visibility-show">
          Ask the engines, edit brands</button>
      </div>
    )
  }
  const hide = () => remember(true)
  return (
    <div className="mx-4 mt-3 mb-1 border border-gray-200 bg-white rounded-lg p-4" data-testid="ai-visibility-guide">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Do AI engines name {v.brand}?</h3>
          <BrandsEditor key={`${v.brand}|${v.competitors.join()}`} v={v} onSaved={onChanged} />
        </div>
        <button type="button" onClick={hide} title="Hide this guide" aria-label="Hide this guide"
          className="p-1 text-gray-400 hover:text-gray-600 rounded"><X className="h-4 w-4" /></button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
        <Step icon={<Radar className="h-4 w-4 text-gray-900" />} title="Ask the engines"
          action={<div className="flex flex-wrap gap-2">
            <AskEngines id={v.id} onStarted={onChanged} />
            {v.answersAt && <CheckAgain id={v.id} onDone={onChanged} />}
          </div>}>
          Each engine column asks its engine every question, from {v.country}. The estimate comes first; asking uses
          your treg key and balance. Add questions as rows, then ask again: only the new ones are asked. Weeks later,
          <b> Check again</b> keeps these answers in dated sheets and asks every question again.
        </Step>
        <Step icon={<MessageSquare className="h-4 w-4 text-gray-600" />} title="Read the answers">
          <b>You in …</b> says where an answer first names you among the brands looked for (“1st of 4”) or Not
          named. <b>Named by</b> counts the engines; <b>Named first</b> is the brand most engines put first. The view
          Not named anywhere lists the questions to work on.
        </Step>
        <Step icon={<Globe className="h-4 w-4 text-gray-600" />} title="The sites AI cites"
          action={v.sitesSheetId ? <button type="button" className="btn-secondary text-xs px-3 py-1"
            onClick={() => navigate(`/table/${v.tableId}/${v.sitesSheetId}`)}>Open Cited sites</button> : undefined}>
          Every source an answer cites, with its domain{v.domain ? ' and whether it’s your site' : ''}. The Domain
          column’s value counts show the sites cited most: the pages worth getting onto.
        </Step>
      </div>
      {v.checks[0] && <LastCheck check={v.checks[0]} tableId={v.tableId} />}
      <p className="text-xs text-gray-500 mt-2">
        Answers vary from one ask to the next: read the totals, not one question.
      </p>
    </div>
  )
}

// The guide when the open sheet is an AI visibility table's questions sheet.
export const SheetAiVisibilityGuide: React.FC<{ sheetData: SheetData | null; onChanged: () => void }> =
  ({ sheetData, onChanged }) => {
    const v = sheetData?.data.aiVisibility
    if (!v) return null
    return <AiVisibilityGuide key={v.id} v={v} onChanged={onChanged} />
  }
