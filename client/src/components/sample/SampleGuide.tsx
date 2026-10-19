import React, { useEffect, useState } from 'react'
import { Check, Copy, Sparkles, X } from 'lucide-react'
import { dedupeAPI, type DedupeCheckResult } from '@/utils/api/dedupe'
import type { SheetData } from '@/utils/api/types'
import { SAMPLE_AI_COLUMN, SAMPLE_DEDUPE_COLUMNS, SAMPLE_GUIDE_CHECK_MAX_ROWS } from '@/lib/constants'

// Above the grid of the sample sheet (Try with sample data): says the data is
// made up, what Cubex filled for free, the duplicate the rows hold (a live
// dry-run check, free) and the AI column waiting for the person's go-ahead.
// Hiding it is remembered in this browser only.
// The server keeps one duplicate check per sheet (the newest stops the one
// before), so the guide checks again on a data change only while the Remove
// duplicates dialog is closed (it would stop the dialog's own check) and while
// the sheet is small: a sample grown by a big import isn't re-scanned on every
// reload, which would hold the sheet and make a sort or rename answer busy.
const hiddenKey = (sheetId: string) => `cubex-sample-guide-hidden-${sheetId}`

interface Props {
  sheetId: string
  dataVersion: number | undefined
  rows: number // the sheet's rows (the guide stops checking above SAMPLE_GUIDE_CHECK_MAX_ROWS)
  dedupeOpen: boolean // the Remove duplicates dialog is open
  aiColumn: string | null // an AI column that has a run of its own now (any name), or null
  onOpenAI: () => void
  onOpenDedupe: () => void
}

export const SampleGuide: React.FC<Props> = (
  { sheetId, dataVersion, rows, dedupeOpen, aiColumn, onOpenAI, onOpenDedupe },
) => {
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(hiddenKey(sheetId)) === '1' } catch { return false }
  })
  const [check, setCheck] = useState<DedupeCheckResult | null>(null)
  const [checkFailed, setCheckFailed] = useState(false)
  const tooBig = rows > SAMPLE_GUIDE_CHECK_MAX_ROWS

  useEffect(() => {
    if (hidden || dedupeOpen || tooBig) return
    const ctl = new AbortController()
    dedupeAPI.check(sheetId, { columns: SAMPLE_DEDUPE_COLUMNS, keep: 'first' }, ctl.signal)
      .then(c => { setCheck(c); setCheckFailed(false) })
      .catch(() => { if (!ctl.signal.aborted) setCheckFailed(true) }) // the card says less; the dialog still works
    return () => ctl.abort()
  }, [sheetId, dataVersion, hidden, dedupeOpen, tooBig])

  if (hidden) return null
  const hide = () => {
    try { localStorage.setItem(hiddenKey(sheetId), '1') } catch { /* hidden for this visit only */ }
    setHidden(true)
  }
  const group = check?.samples[0]

  return (
    <div className="mx-4 mt-3 mb-1 border border-gray-200 bg-white rounded-lg p-4" data-testid="sample-guide">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Sample data: everything here is made up</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            25 invented leads at .example addresses, with a few messy values on purpose. Delete the table when
            you're done: it goes to the trash like any table.
          </p>
        </div>
        <button type="button" onClick={hide} title="Hide this guide" aria-label="Hide this guide"
          className="p-1 text-gray-400 hover:text-gray-600 rounded">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
        <Step icon={<Check className="h-4 w-4 text-green-600" />} title="Filled for free">
          <b>Company (clean)</b> tidies the company names and <b>Seniority</b> is a formula that reads each title.
          No AI, no cost, and new rows fill by themselves.
        </Step>
        <Step icon={<Copy className="h-4 w-4 text-gray-600" />} title="A duplicate"
          action={<button type="button" className="btn-secondary text-xs px-3 py-1" onClick={onOpenDedupe}>
            Review duplicates</button>}>
          {checkFailed || tooBig ? 'Priya Raman is in the list twice, her email written differently.'
            : !check ? 'Checking the emails…'
            : group ? <>Row {group.removed[0]?.row} repeats row {group.kept.row}: the same email, written
              differently. Rows without an email are never counted.</>
              : 'No duplicate emails left.'}
        </Step>
        <Step icon={<Sparkles className="h-4 w-4 text-gray-900" />}
          title={aiColumn ? 'AI column' : 'Next: the AI column'}
          action={aiColumn ? undefined : <button type="button" className="btn-primary text-xs px-3 py-1"
            onClick={onOpenAI} data-testid="sample-try-ai">Try on 5 rows…</button>}>
          {aiColumn ? <>You ran <b>{aiColumn}</b>. Its column menu runs it again or on more rows.</>
            : <><b>{SAMPLE_AI_COLUMN}</b> asks your AI model whether each lead is a good fit. It's set up, not
              run: pick your model and try it on 5 rows first. It uses your OpenRouter key (add it in
              Settings → AI), and nothing runs until you click.</>}
        </Step>
      </div>
    </div>
  )
}

const Step: React.FC<{ icon: React.ReactNode; title: string; action?: React.ReactNode; children: React.ReactNode }> =
  ({ icon, title, action, children }) => (
    <div className="border border-gray-100 bg-gray-50 rounded p-3 flex flex-col">
      <div className="flex items-center gap-2 text-sm font-medium text-gray-900">{icon}<span>{title}</span></div>
      <p className="text-xs text-gray-600 mt-1 flex-1">{children}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )

// The AI column that has run: the sample's own when it has, else any other
// (a run under another name in the drawer moves the guide on all the same).
function ranAiColumn(sheetData: SheetData): string | null {
  const types = sheetData.data.columnTypes ?? {}
  if (types[SAMPLE_AI_COLUMN] === 'ai-output') return SAMPLE_AI_COLUMN
  return sheetData.data.columns.find(c => types[c] === 'ai-output') ?? null
}

// The guide when the open sheet is the sample (GET /api/sheets/:id says so).
export const SheetSampleGuide: React.FC<{
  sheetData: SheetData | null; dedupeOpen: boolean; onOpenAI: () => void; onOpenDedupe: () => void
}> = ({ sheetData, dedupeOpen, onOpenAI, onOpenDedupe }) => {
  if (!sheetData?.data.sample) return null
  const id = sheetData.sheet.id
  return <SampleGuide key={id} sheetId={id} dataVersion={sheetData.sheet.data_version}
    rows={sheetData.data.totalRows} dedupeOpen={dedupeOpen} aiColumn={ranAiColumn(sheetData)}
    onOpenAI={onOpenAI} onOpenDedupe={onOpenDedupe} />
}
