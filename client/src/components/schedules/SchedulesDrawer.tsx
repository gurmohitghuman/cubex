// Over 200 lines: the drawer's list of schedules and its add form, one screen read together.
import React, { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { CalendarClock, Loader2, Pause, Play, Trash2, Zap } from 'lucide-react'
import { Drawer, DrawerBody, DrawerHeader } from '@/components/Drawer'
import {
  runSchedulesAPI, type NewRunSchedule, type RunSchedule, type ScheduleCadence, type ScheduleRows,
} from '@/utils/api'

interface Props { isOpen: boolean; onClose: () => void; sheetId: string }

const ROWS: Array<[ScheduleRows, string]> = [
  ['empty', 'Empty rows'], ['errored', 'Failed rows'], ['out_of_date', 'Out-of-date rows'], ['all', 'Every row'],
]
const CADENCES: Array<[ScheduleCadence, string]> = [
  ['daily', 'Every day'], ['weekdays', 'Every weekday'], ['weekly', 'Every week'], ['monthly', 'Every month'],
  ['hours', 'Every few hours'],
]
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const localZone = (): string => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}) : 'never')
const errorOf = (e: any, fallback: string): string => e?.response?.data?.error || fallback

// When a schedule fires, in words: "Every Monday at 09:00 (Europe/Berlin)".
function cadenceWords(s: RunSchedule): string {
  if (s.cadence === 'hours') return `Every ${s.every_hours} hour${s.every_hours === 1 ? '' : 's'}`
  const at = `at ${s.at_time} (${s.time_zone})`
  if (s.cadence === 'weekly') return `Every ${DAYS[s.weekday ?? 0]} ${at}`
  if (s.cadence === 'monthly') return `Every month on day ${s.month_day} ${at}`
  return `${s.cadence === 'weekdays' ? 'Every weekday' : 'Every day'} ${at}`
}

// The sheet's scheduled reruns: each one's columns, rows, cadence, next and last firing (and why the last one
// didn't start), to pause, resume, fire now or delete; and a form to add one. Each firing is a column run.
export const SchedulesDrawer: React.FC<Props> = ({ isOpen, onClose, sheetId }) => {
  const [schedules, setSchedules] = useState<RunSchedule[]>([])
  const [runColumns, setRunColumns] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<NewRunSchedule>(() => ({
    sheet_id: sheetId, columns: null, rows: 'empty', cadence: 'daily', at_time: '09:00', time_zone: localZone(),
    weekday: 1, month_day: 1, every_hours: 6, max_cost_usd: null,
  }))

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const out = await runSchedulesAPI.list(sheetId)
      setSchedules(out.schedules)
      setRunColumns(out.run_columns)
      setError(null)
    } catch (e: any) {
      setError(errorOf(e, "Couldn't read the schedules"))
    } finally { setLoading(false) }
  }, [sheetId])
  useEffect(() => { if (isOpen) void load() }, [isOpen, load])
  useEffect(() => { setForm(f => ({ ...f, sheet_id: sheetId })) }, [sheetId])

  const act = async (id: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(id)
    try {
      await fn()
      if (done) toast.success(done)
      await load()
    } catch (e: any) {
      toast.error(errorOf(e, "Couldn't do that"))
    } finally { setBusy(null) }
  }

  // Run now answers the schedule: a firing that couldn't start (or started only on some sheets) says why.
  const fireNow = (id: string) => void act(id, async () => {
    const s = await runSchedulesAPI.fireNow(id)
    if (!s.last_error) toast.success('Started')
    else toast.error(s.last_run_ids.length ? `Started, except: ${s.last_error}` : `It didn't start: ${s.last_error}`)
  })

  const add = (e: React.FormEvent) => {
    e.preventDefault()
    const f = form
    const body: NewRunSchedule = {
      sheet_id: f.sheet_id, columns: f.columns, rows: f.rows, cadence: f.cadence, time_zone: f.time_zone,
      max_cost_usd: f.max_cost_usd || null,
      ...(f.cadence === 'hours' ? { every_hours: f.every_hours } : { at_time: f.at_time }),
      ...(f.cadence === 'weekly' ? { weekday: f.weekday } : {}),
      ...(f.cadence === 'monthly' ? { month_day: f.month_day } : {}),
    }
    void act('new', () => runSchedulesAPI.create(body), 'Schedule added')
  }
  const toggleColumn = (c: string) => setForm(f => {
    const now = f.columns ?? []
    const next = now.includes(c) ? now.filter(x => x !== c) : [...now, c]
    return { ...f, columns: next.length ? next : null }
  })
  const set = <K extends keyof NewRunSchedule>(k: K, v: NewRunSchedule[K]) => setForm(f => ({ ...f, [k]: v }))

  return (
    <Drawer isOpen={isOpen} onClose={onClose} panelClassName="max-w-lg">
      <DrawerHeader icon={<CalendarClock className="h-5 w-5 text-gray-700" />} title="Scheduled reruns"
        onClose={onClose}
        description="Run this sheet's run columns again on a schedule. Each run costs what the columns cost." />
      <DrawerBody>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {loading && schedules.length === 0 && (
          <p className="text-sm text-gray-600 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />
            Loading…</p>
        )}
        {!loading && !error && schedules.length === 0 && (
          <p className="text-sm text-gray-600" data-testid="schedules-empty">No schedules yet.</p>
        )}
        <ul className="space-y-2" data-testid="schedules-list">
          {schedules.map(s => (
            <li key={s.id} className="rounded-md border border-gray-200 p-3" data-testid="schedule-item">
              <p className="text-sm font-medium text-gray-900">{cadenceWords(s)}{s.paused ? ' · paused' : ''}</p>
              <p className="text-xs text-gray-600">
                {s.columns ? s.columns.join(', ') : 'Every run column'} · {ROWS.find(r => r[0] === s.rows)?.[1]}
                {s.max_cost_usd ? ` · at most $${s.max_cost_usd} a run` : ''}
                {s.table_id ? ' · every sheet of the table' : ''}
              </p>
              <p className="text-xs text-gray-500">
                Next: {s.paused ? 'paused' : when(s.next_at)} · Last: {when(s.last_fired_at)}
              </p>
              {s.last_error && <p className="text-xs text-red-600" data-testid="schedule-error">{s.last_error}</p>}
              <div className="mt-2 flex gap-3 text-xs">
                <button type="button" className="flex items-center gap-1 underline text-gray-700"
                  disabled={busy !== null} data-testid="schedule-pause"
                  onClick={() => void act(s.id, () => runSchedulesAPI.setPaused(s.id, !s.paused))}>
                  {s.paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                  {s.paused ? 'Resume' : 'Pause'}
                </button>
                <button type="button" className="flex items-center gap-1 underline text-gray-700"
                  disabled={busy !== null} data-testid="schedule-fire"
                  onClick={() => fireNow(s.id)}>
                  <Zap className="h-3 w-3" />Run now
                </button>
                <button type="button" className="flex items-center gap-1 underline text-red-700"
                  disabled={busy !== null} data-testid="schedule-delete"
                  onClick={() => void act(s.id, () => runSchedulesAPI.remove(s.id), 'Schedule deleted')}>
                  <Trash2 className="h-3 w-3" />Delete
                </button>
              </div>
            </li>
          ))}
        </ul>

        <form onSubmit={add} className="space-y-3 border-t border-gray-200 pt-4" data-testid="schedule-form">
          <p className="meta-label">Add a schedule</p>
          {runColumns.length === 0 ? (
            <p className="text-sm text-gray-600">This sheet has no run columns yet (AI, HTTP API, enrichment or
              waterfall columns).</p>
          ) : (
            <fieldset className="space-y-1">
              <legend className="text-xs text-gray-600">Columns (none ticked: every run column)</legend>
              {runColumns.map(c => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={!!form.columns?.includes(c)} onChange={() => toggleColumn(c)} />
                  {c}
                </label>
              ))}
            </fieldset>
          )}
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-gray-600">Rows
              <select className="input mt-1 w-full" value={form.rows} data-testid="schedule-rows"
                onChange={e => set('rows', e.target.value as ScheduleRows)}>
                {ROWS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </label>
            <label className="text-xs text-gray-600">How often
              <select className="input mt-1 w-full" value={form.cadence} data-testid="schedule-cadence"
                onChange={e => set('cadence', e.target.value as ScheduleCadence)}>
                {CADENCES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </label>
            {form.cadence === 'weekly' && (
              <label className="text-xs text-gray-600">Day
                <select className="input mt-1 w-full" value={form.weekday}
                  onChange={e => set('weekday', Number(e.target.value))}>
                  {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select>
              </label>
            )}
            {form.cadence === 'monthly' && (
              <label className="text-xs text-gray-600">Day of the month
                <select className="input mt-1 w-full" value={form.month_day}
                  onChange={e => set('month_day', Number(e.target.value))}>
                  {Array.from({ length: 28 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
                </select>
              </label>
            )}
            {form.cadence === 'hours' ? (
              <label className="text-xs text-gray-600">Every how many hours
                <input type="number" min={1} max={168} className="input mt-1 w-full" value={form.every_hours}
                  onChange={e => set('every_hours', Number(e.target.value))} />
              </label>
            ) : (
              <label className="text-xs text-gray-600">At
                <input type="time" className="input mt-1 w-full" value={form.at_time} data-testid="schedule-time"
                  onChange={e => set('at_time', e.target.value)} />
              </label>
            )}
            {form.cadence !== 'hours' && (
              <label className="text-xs text-gray-600">Time zone
                <input className="input mt-1 w-full" value={form.time_zone}
                  onChange={e => set('time_zone', e.target.value)} />
              </label>
            )}
            <label className="text-xs text-gray-600">Most a run may cost ($, optional)
              <input type="number" min={0} step="0.01" className="input mt-1 w-full"
                value={form.max_cost_usd ?? ''}
                onChange={e => set('max_cost_usd', e.target.value === '' ? null : Number(e.target.value))} />
            </label>
          </div>
          <button type="submit" className="btn-primary" disabled={busy !== null || runColumns.length === 0}
            data-testid="schedule-add">
            {busy === 'new' ? 'Adding…' : 'Add schedule'}
          </button>
          <p className="text-xs text-gray-500">
            A run missed while Cubex was stopped runs once when it starts. A run that couldn&apos;t start says why here.
          </p>
        </form>
      </DrawerBody>
    </Drawer>
  )
}
