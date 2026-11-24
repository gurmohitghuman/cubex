import { api } from './client'

// Scheduled reruns of a sheet's run columns (the sheet's ⋯ menu, Scheduled reruns).
export type ScheduleRows = 'empty' | 'errored' | 'out_of_date' | 'all'
export type ScheduleCadence = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'hours'
export interface RunSchedule {
  id: string
  sheet_id: string | null
  table_id: string | null
  columns: string[] | null
  rows: ScheduleRows
  cadence: ScheduleCadence
  at_time: string | null
  time_zone: string
  weekday: number | null
  month_day: number | null
  every_hours: number | null
  max_cost_usd: number | null
  allow_unpriced: boolean
  paused: boolean
  next_at: string
  last_fired_at: string | null
  last_run_ids: string[]
  last_error: string | null
  made_by: string
}
export interface NewRunSchedule {
  sheet_id: string
  columns: string[] | null
  rows: ScheduleRows
  cadence: ScheduleCadence
  at_time?: string
  time_zone: string
  weekday?: number
  month_day?: number
  every_hours?: number
  max_cost_usd?: number | null
}

export const runSchedulesAPI = {
  // The sheet's schedules (and its table's), and the run columns a schedule can name.
  list: (sheetId: string): Promise<{ schedules: RunSchedule[]; run_columns: string[] }> =>
    api.get('/settings/run-schedules', { params: { sheet_id: sheetId } })
      .then(res => ({ schedules: res.data.schedules, run_columns: res.data.run_columns ?? [] })),
  create: (s: NewRunSchedule): Promise<RunSchedule> => api.post('/settings/run-schedules', s).then(res => res.data),
  setPaused: (id: string, paused: boolean): Promise<RunSchedule> =>
    api.patch(`/settings/run-schedules/${id}`, { paused }).then(res => res.data),
  fireNow: (id: string): Promise<RunSchedule> => api.post(`/settings/run-schedules/${id}/fire`).then(res => res.data),
  remove: (id: string): Promise<void> => api.delete(`/settings/run-schedules/${id}`).then(() => undefined),
}
