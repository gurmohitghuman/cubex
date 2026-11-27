import { test, expect } from '@playwright/test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, makeAccessToken } from './helpers'
import { makeToken, bearer } from './api-v1-run-helpers'
import { mcpClient, call } from './helpers-mcp'
import { Receiver } from './helpers-receiver'
import { waitSetup, column } from './helpers-setups'
import { SITES, short as shortAs, twoColumns as build } from './helpers-column-runs'

// Running chosen columns on chosen rows (run_columns, POST /api/v1/sheets/:id/column-runs). Two HTTP API
// columns on the spec's receiver: Lookup (a site's short name into Short), and Echo, which reads the
// formula Label = Short + "!". Echo's auto-run is on.
//   - MCP: the estimate (its default) lists both in the order they run and starts nothing; started in
//     "all", Echo waits while Lookup's answers are held, then runs on the new labels only: each new
//     label is asked once (Echo's auto-run held off while it waited, and nothing after), the old ones never.
//   - REST: estimate_only defaults to false; mode is required; a where on a column the run changes is
//     refused, and so is a formula column; row_ids keep it to those rows; a stop reaches the step's run
//     and starts nothing more. (The secrets and ceiling refusals: tests/unit/column-run.test.ts.)
const rx = new Receiver()
const short = (suffix: string) => shortAs(rx, suffix)
const twoColumns = async (client: Client, api: Awaited<ReturnType<typeof authedApi>>) =>
  (await build(rx, client, api)).sheetId
test.beforeAll(() => rx.start())
test.afterAll(() => rx.stop())
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('run_columns: an estimate first; Echo waits for Lookup and its formula, and its auto-run holds off', async () => {
  test.setTimeout(180_000)
  const api = await authedApi()
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'column-runs'))
  const sheetId = await twoColumns(client, api)
  await call(client, 'set_auto_run', { sheet_id: sheetId, column: 'Echo', enabled: true })
  const asked = (v: string) => SITES.map(s => rx.hitsOn(`/echo/${s}${v}`).length)
  expect(asked('!')).toEqual([1, 1, 1])

  // The estimate: both columns in the order they run (Echo named by its output column), nothing started.
  const est = (await call(client, 'run_columns', { sheet_id: sheetId, columns: ['Echo ok', 'Short'], mode: 'all' }))
    .estimate
  expect(est.columns.map((c: any) => [c.column, c.kind, c.layer, c.rows, c.sends_requests]))
    .toEqual([['Lookup', 'http', 1, 3, true], ['Echo', 'http', 2, 3, true]])
  expect(est.unpriced).toEqual([])
  expect((await call(client, 'get_run', { action: 'setup', sheet_id: sheetId })).setup_runs).toEqual([])

  // Started on new short names, Lookup's answers held: Echo waits.
  short('2')
  const release = rx.hold(SITES.map(s => `/short/${s}.com`))
  const run = (await call(client, 'run_columns', { sheet_id: sheetId, columns: ['Echo ok', 'Short'], mode: 'all',
    estimate_only: false })).setup_run
  expect(run.setup_id).toBeNull()
  expect(run.column_run).toEqual({ mode: 'all', row_ids: null, where: null })
  await rx.waitFor('/short/one.com', 2)
  const waiting = await call(client, 'get_run', { action: 'setup', setup_run_id: run.id })
  expect(waiting.steps.map((s: any) => [s.column, s.state])).toEqual([['Lookup', 'running'], ['Echo', 'waiting']])
  release()
  const done = await waitSetup(client, run.id)
  expect(done.status).toBe('done')
  expect(await column(api, sheetId, 'Label')).toEqual(['one2!', 'two2!', 'three2!'])
  expect(await column(api, sheetId, 'Echo ok')).toEqual(['yes', 'yes', 'yes'])
  // Each new label asked once (no auto-run run beside the step), the old ones never again; still so a while later.
  expect(asked('2!')).toEqual([1, 1, 1])
  expect(asked('!')).toEqual([1, 1, 1])
  await sleep(4000)
  expect(asked('2!')).toEqual([1, 1, 1])
  const { changes: [line] } = await call(client, 'get_sheet', { history: true, sheet_id: sheetId, limit: 1 })
  expect(line.summary).toBe('Ran 2 columns (Lookup, Echo) on every row')
})

test('POST /api/v1/sheets/:id/column-runs: refusals, row_ids, and a stop', async () => {
  test.setTimeout(180_000)
  const api = await authedApi()
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'column-runs-rest'))
  const sheetId = await twoColumns(client, api)
  const run = await bearer(await makeToken(api, ['read', 'write', 'run', 'secrets'], 'column-runs v1'))
  const post = (data: Record<string, unknown>) => run.post(`/api/v1/sheets/${sheetId}/column-runs`, { data })

  const noMode = await post({ columns: ['Lookup'] })
  expect(noMode.status()).toBe(400)
  expect((await noMode.json()).error).toMatch(/^mode is required/)
  const onLabel = await post({ columns: ['Lookup', 'Echo'], mode: 'all',
    where: [{ column: 'Label', operator: 'eq', value: 'one!' }] })
  expect(onLabel.status()).toBe(400)
  expect((await onLabel.json()).error).toMatch(/The where reads "Label", which this run changes/)
  const formula = await post({ columns: ['Label'], mode: 'all' })
  expect((await formula.json()).error).toMatch(/"Label" is a formula column/)
  const estimate = await post({ columns: ['Lookup'], mode: 'all', estimate_only: true })
  expect(estimate.status()).toBe(200)
  expect((await estimate.json()).estimate.columns[0].rows).toBe(3)

  // row_ids: only the first row runs (here Lookup alone, on new names).
  short('3')
  const rows = (await (await run.post(`/api/v1/sheets/${sheetId}/rows/query`,
    { data: { return_mode: 'ids', limit: 3 } })).json()).rows as Array<{ id: string }>
  const one = await post({ columns: ['Short'], mode: 'all', row_ids: [rows[0].id] })
  expect(one.status()).toBe(201)
  const oneRun = (await one.json()).setup_run
  expect(oneRun.column_run.row_ids).toBe(1)
  await expect.poll(async () => (await (await run.get(`/api/v1/setup-runs/${oneRun.id}`)).json()).status,
    { timeout: 30_000 }).toBe('done')
  expect(await column(api, sheetId, 'Short')).toEqual(['one3', 'two', 'three'])

  // A stop while Lookup's answers are held: its run stops, Echo never starts.
  const release = rx.hold(SITES.map(s => `/short/${s}.com`))
  const started = await post({ columns: ['Lookup', 'Echo'], mode: 'all' })
  expect(started.status()).toBe(201)
  const id = (await started.json()).setup_run.id
  const stop = await run.post(`/api/v1/setup-runs/${id}/control`, { data: { action: 'cancel' } })
  expect((await stop.json()).status).toBe('cancelled')
  release()
  await rx.settled()
  await sleep(2000)
  const stopped = await (await run.get(`/api/v1/setup-runs/${id}`)).json()
  expect(stopped.steps.map((s: any) => s.state)).toEqual(['running', 'waiting'])
  expect((await call(client, 'get_run', {
    action: 'status', run_type: 'http', run_id: stopped.steps[0].run_id })).status)
    .toBe('cancelled')
})
