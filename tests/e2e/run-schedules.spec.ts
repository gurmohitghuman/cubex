import { test, expect } from '@playwright/test'
import { BASE, authedApi, makeAccessToken } from './helpers'
import { freshTreg, seedLeadRows } from './helpers-enrich'
import { mcpClient, call, callError, waitMcpRun } from './helpers-mcp'

// Scheduled reruns over MCP and REST (services/run-schedule*.ts), against the mock treg: an enrichment column on a
// sheet; a schedule made (fields checked), listed, changed, paused and resumed; fired now, it starts one column run
// as the token (get_setup_run follows it) and keeps it in last_run_ids, its next time unchanged; a sheet with no run
// columns says so in last_error; REST lists, makes, pauses and deletes, and a read-only token can only list. REST
// prices a firing now without starting it.
test('a run schedule: made, changed, paused, fired now as a column run, deleted', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], `schedules-${Date.now()}`)
  const client = await mcpClient(token)
  const { sheetId } = await seedLeadRows(api, [{ Name: 'Maya Chen', Website: 'stripe.com' }])
  const run = await call(client, 'run_enrichment', { sheet_id: sheetId, tool_id: 'treg.people.email.find',
    column_name: 'Work email', inputs: { full_name: 'Name', domain: 'Website' },
    outputs: [{ field: 'email', column_name: 'Email' }] })
  await waitMcpRun(client, run.run_id, ['completed', 'failed'])

  expect(await callError(client, 'manage_run_schedule', { action: 'create', sheet_id: sheetId, rows: 'all',
    cadence: 'weekly', at_time: '09:00' })).toContain('weekday')
  const made = (await call(client, 'manage_run_schedule', { action: 'create', sheet_id: sheetId, rows: 'all',
    cadence: 'weekly', weekday: 1, at_time: '09:00', time_zone: 'Europe/Berlin', max_cost_usd: 5 })).schedule
  expect(made.made_by).toContain('schedules-')
  expect(new Date(made.next_at).getTime()).toBeGreaterThan(Date.now())
  const listed = (await call(client, 'manage_run_schedule', { action: 'list', sheet_id: sheetId })).schedules
  expect(listed.map((s: any) => s.id)).toEqual([made.id])

  const changed = (await call(client, 'manage_run_schedule', { action: 'change', schedule_id: made.id,
    cadence: 'daily', at_time: '06:30' })).schedule
  expect(changed.cadence).toBe('daily')
  expect((await call(client, 'manage_run_schedule', { action: 'pause', schedule_id: made.id })).schedule.paused)
    .toBe(true)
  expect((await call(client, 'manage_run_schedule', { action: 'resume', schedule_id: made.id })).schedule.paused)
    .toBe(false)

  // What firing it now would cost (REST): the enrichment column on the one row, and nothing starts.
  const runsBefore = (await call(client, 'list_runs', { sheet_id: sheetId })).runs.length
  const priced = await (await api.get(`${BASE}/api/v1/run-schedules/${made.id}/estimate`,
    { headers: { Authorization: `Bearer ${token}` } })).json()
  expect(priced.problems).toEqual([])
  expect(priced.sheets.map((s: any) => [s.sheet_id, s.estimate.columns.map((c: any) => [c.column, c.rows])]))
    .toEqual([[sheetId, [['Work email', 1]]]])
  expect((await call(client, 'list_runs', { sheet_id: sheetId })).runs.length).toBe(runsBefore)

  const fired = (await call(client, 'manage_run_schedule', { action: 'fire_now', schedule_id: made.id })).schedule
  expect(fired.last_error).toBeNull()
  expect(fired.last_run_ids.length).toBe(1)
  const setupRun = await call(client, 'get_setup_run', { setup_run_id: fired.last_run_ids[0] })
  expect(setupRun.steps.map((s: any) => s.column)).toEqual(['Work email'])

  const { sheetId: bare } = await seedLeadRows(api, [{ Name: 'Leo', Website: 'notion.so' }])
  const none = (await call(client, 'manage_run_schedule', { action: 'create', sheet_id: bare, rows: 'empty',
    cadence: 'hours', every_hours: 6 })).schedule
  const noneFired = (await call(client, 'manage_run_schedule', { action: 'fire_now', schedule_id: none.id })).schedule
  expect(noneFired.last_error).toContain('no run columns')

  // REST.
  const auth = { Authorization: `Bearer ${token}` }
  const list = await (await api.get(`${BASE}/api/v1/run-schedules?sheet_id=${sheetId}`, { headers: auth })).json()
  expect(list.schedules.length).toBe(1)
  const restMade = await api.post(`${BASE}/api/v1/run-schedules`, { headers: auth,
    data: { sheet_id: bare, rows: 'errored', cadence: 'monthly', month_day: 28, at_time: '23:00' } })
  expect(restMade.status()).toBe(201)
  const restId = (await restMade.json()).id
  const paused = await api.patch(`${BASE}/api/v1/run-schedules/${restId}`, { headers: auth, data: { paused: true } })
  expect((await paused.json()).paused).toBe(true)
  expect((await api.post(`${BASE}/api/v1/run-schedules`, { headers: auth,
    data: { sheet_id: bare, rows: 'empty', cadence: 'daily', at_time: '25:00' } })).status()).toBe(400)
  const readOnly = await makeAccessToken(api, ['read'], `schedules-read-${Date.now()}`)
  const ro = { Authorization: `Bearer ${readOnly}` }
  expect((await api.get(`${BASE}/api/v1/run-schedules`, { headers: ro })).status()).toBe(200)
  expect((await api.delete(`${BASE}/api/v1/run-schedules/${restId}`, { headers: ro })).status()).toBe(403)
  // What firing it now would cost (REST): a sheet with no run columns says why it wouldn't start; a read-only token
  // can't ask.
  const bareCost = await (await api.get(`${BASE}/api/v1/run-schedules/${none.id}/estimate`, { headers: auth })).json()
  expect([bareCost.sheets, bareCost.problems]).toEqual([[], ['The sheet has no run columns.']])
  expect((await api.get(`${BASE}/api/v1/run-schedules/${made.id}/estimate`, { headers: ro })).status()).toBe(403)
  for (const id of [restId, none.id, made.id]) {
    expect((await api.delete(`${BASE}/api/v1/run-schedules/${id}`, { headers: auth })).status()).toBe(200)
  }
})
