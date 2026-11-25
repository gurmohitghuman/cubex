// What a scheduled rerun would cost if it ran now, in the Scheduled reruns drawer: one line before Add schedule
// (the form's columns and rows, priced as the Run columns dialog prices them) and one on each schedule before Run
// now (the server prices its firing, a table's sheet by sheet). Both are reads: nothing starts, nothing is spent.
// Asked again at once on a click or a pick, and after the typing wait in a typed box (hooks/useTypedReads.ts); the
// last line stays, dimmed, while the next one loads.
import React, { useMemo } from 'react'
import { usePreviewRead, type PreviewState } from '@/hooks/useTypedReads'
import { columnRunsAPI, type ColumnRunEstimate } from '@/utils/api/column-runs'
import { runSchedulesAPI, type NewRunSchedule, type RunSchedule } from '@/utils/api'
import { costWords } from './schedule-cost-copy'

interface Cost { estimates: ColumnRunEstimate[]; problems: string[] }

export const ScheduleCostLine: React.FC<{ state: PreviewState<Cost>; testId: string }> = ({ state, testId }) => {
  if (state.error) return <p className="text-xs text-red-600" data-testid={testId}>{state.error}</p>
  if (!state.result) {
    return state.loading
      ? <p className="text-xs text-gray-500" data-testid={testId}>Working out what a run now would cost…</p>
      : null
  }
  const { estimates, problems } = state.result
  return (
    <div className={`text-xs ${state.loading ? 'opacity-60' : ''}`} data-testid={testId}>
      {(estimates.length > 0 || problems.length === 0) && <p className="text-gray-700">{costWords(estimates)}</p>}
      {problems.map(p => <p key={p} className="text-red-600">A run now wouldn&apos;t start: {p}</p>)}
    </div>
  )
}

// The listed schedules are priced one at a time, top first: each estimate reads the sheet's rows (in slices), so a
// long list doesn't ask the server for all of them at once. One closed meanwhile is aborted, so it is skipped.
let turns: Promise<unknown> = Promise.resolve()
function inTurn<T>(read: () => Promise<T>): Promise<T> {
  const mine = turns.then(read)
  turns = mine.catch(() => undefined)
  return mine
}

// A listed schedule's firing, priced by the server; asked again when the schedule changes or fires.
export const ScheduleItemCost: React.FC<{ sheetId: string; schedule: RunSchedule }> = ({ sheetId, schedule }) => {
  const body = useMemo(() => ({ id: schedule.id, at: `${schedule.updated_at}|${schedule.last_fired_at}` }),
    [schedule.id, schedule.updated_at, schedule.last_fired_at])
  const state = usePreviewRead(sheetId, body, async (_sid, b, signal): Promise<Cost> => {
    const e = await inTurn(() => runSchedulesAPI.estimate(b.id, signal))
    return { estimates: e.sheets.map(s => s.estimate), problems: e.problems }
  }, "Couldn't work out what a run now would cost.")
  return <ScheduleCostLine state={state} testId="schedule-cost" />
}

// The add form's schedule, priced as the Run columns dialog prices the same columns and rows on this sheet.
export function useFormCost(sheetId: string, open: boolean, form: NewRunSchedule, runColumns: string[]) {
  const body = useMemo(() => {
    if (!open || runColumns.length === 0) return null
    const max = form.max_cost_usd
    return { columns: form.columns ?? runColumns, mode: form.rows, ...(max && max > 0 ? { maxCostUsd: max } : {}) }
  }, [open, runColumns, form.columns, form.rows, form.max_cost_usd])
  return usePreviewRead(sheetId, body, async (id, b, signal): Promise<Cost> => {
    const out = await columnRunsAPI.run(id, { ...b, estimateOnly: true }, signal)
    if (!('estimate' in out)) throw new Error('It started instead of pricing.')
    const e = out.estimate
    return e.over_ceiling ? { estimates: [], problems: [e.ceiling_problem ?? 'It could cost more than that.'] }
      : { estimates: [e], problems: [] }
  }, "Couldn't work out what a run now would cost.")
}
