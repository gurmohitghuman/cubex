// When a run schedule fires next (lib/run-schedule-time.ts), pure: daily, weekdays, weekly, monthly and every N
// hours, in a time zone; a wall time a clock change skips fires at the first minute after it, one that happens twice
// fires the first time (also in a zone more than 12 hours from UTC); and the time fields are checked.
import assert from 'node:assert/strict'
import timeMod from '../../server/src/lib/run-schedule-time'
const { nextFireAt, scheduleTimeProblem } = timeMod as typeof import('../../server/src/lib/run-schedule-time')
import type { ScheduleTime } from '../../server/src/lib/run-schedule-time'

let failures = 0
function check(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).message)
  }
}
const at = (iso: string) => Date.parse(iso)
const iso = (ms: number) => new Date(ms).toISOString()
const base: ScheduleTime = { cadence: 'daily', atTime: '09:00', timeZone: 'Europe/Berlin', weekday: null,
  monthDay: null, everyHours: null }
const next = (t: Partial<ScheduleTime>, after: string) => iso(nextFireAt({ ...base, ...t }, at(after)))

check('daily: later today, else tomorrow (Berlin, winter UTC+1)', () => {
  assert.equal(next({}, '2026-01-15T07:00:00Z'), '2026-01-15T08:00:00.000Z')
  assert.equal(next({}, '2026-01-15T08:00:00Z'), '2026-01-16T08:00:00.000Z')
})
check('daily in summer (UTC+2) and across the change', () => {
  assert.equal(next({}, '2026-07-01T12:00:00Z'), '2026-07-02T07:00:00.000Z')
  assert.equal(next({}, '2026-03-28T12:00:00Z'), '2026-03-29T07:00:00.000Z')
})
check('weekdays skip Saturday and Sunday', () => {
  assert.equal(next({ cadence: 'weekdays' }, '2026-11-27T09:00:00Z'), '2026-11-30T08:00:00.000Z') // Fri after -> Mon
})
check('weekly on a weekday', () => {
  assert.equal(next({ cadence: 'weekly', weekday: 3 }, '2026-11-24T12:00:00Z'), '2026-11-25T08:00:00.000Z')
  assert.equal(next({ cadence: 'weekly', weekday: 3 }, '2026-11-25T09:00:00Z'), '2026-12-02T08:00:00.000Z')
})
check('monthly on day 28, February included', () => {
  assert.equal(next({ cadence: 'monthly', monthDay: 28 }, '2026-01-30T00:00:00Z'), '2026-02-28T08:00:00.000Z')
})
check('every N hours goes on from the last firing', () => {
  assert.equal(next({ cadence: 'hours', everyHours: 6, atTime: null }, '2026-11-24T10:15:00Z'),
    '2026-11-24T16:15:00.000Z')
})
check('a skipped wall time fires at the first minute after it (New York, 02:30 on 2026-03-08)', () => {
  assert.equal(next({ timeZone: 'America/New_York', atTime: '02:30' }, '2026-03-08T00:00:00Z'),
    '2026-03-08T07:00:00.000Z')
})
check('a wall time that happens twice fires the first time (New York, 01:30 on 2026-11-01)', () => {
  assert.equal(next({ timeZone: 'America/New_York', atTime: '01:30' }, '2026-11-01T00:00:00Z'),
    '2026-11-01T05:30:00.000Z')
})
// Chatham is UTC+13:45 in summer and +12:45 in winter, its clocks changing at 03:45 (back) and 02:45 (forward).
check('a zone more than 12 hours from UTC: the first time of a doubled hour, and an hour that is not skipped', () => {
  const chatham = { timeZone: 'Pacific/Chatham' }
  // 2026-04-05 local, 02:56 happens at 13:11Z (+13:45), then again at 14:11Z (+12:45): the first, and once a day.
  assert.equal(next({ ...chatham, atTime: '02:56' }, '2026-04-04T11:36:00Z'), '2026-04-04T13:11:00.000Z')
  assert.equal(next({ ...chatham, atTime: '02:56' }, '2026-04-04T13:12:00Z'), '2026-04-05T14:11:00.000Z')
  // 2026-09-27 local, 02:44 jumps to 03:45: 02:12 still happens (13:27Z), 03:00 is skipped (first minute: 03:45).
  assert.equal(next({ ...chatham, atTime: '02:12' }, '2026-09-26T11:16:00Z'), '2026-09-26T13:27:00.000Z')
  assert.equal(next({ ...chatham, atTime: '03:00' }, '2026-09-26T11:16:00Z'), '2026-09-26T14:00:00.000Z')
})
check('time zones with a half hour, and UTC', () => {
  assert.equal(next({ timeZone: 'Asia/Kolkata' }, '2026-11-24T00:00:00Z'), '2026-11-24T03:30:00.000Z')
  assert.equal(next({ timeZone: 'UTC' }, '2026-11-24T00:00:00Z'), '2026-11-24T09:00:00.000Z')
})
check('the fields are checked', () => {
  assert.match(scheduleTimeProblem({ ...base, timeZone: 'Mars/Base' })!, /isn't a time zone/)
  assert.match(scheduleTimeProblem({ ...base, atTime: '9:00' })!, /HH:MM/)
  assert.match(scheduleTimeProblem({ ...base, cadence: 'weekly' })!, /weekday/)
  assert.match(scheduleTimeProblem({ ...base, cadence: 'monthly', monthDay: 29 })!, /1 to 28/)
  assert.match(scheduleTimeProblem({ ...base, cadence: 'hours', everyHours: 0 })!, /1 to 168/)
  assert.equal(scheduleTimeProblem(base), null)
})

if (failures > 0) { console.error(`${failures} run-schedule-time check(s) failed`); process.exit(1) }
console.log('run-schedule-time: all assertions passed')
