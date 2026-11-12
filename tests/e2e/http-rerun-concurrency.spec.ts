import { test, expect, type APIRequestContext } from '@playwright/test'
import Database from 'better-sqlite3'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { authedApi, seedSheet, importCsv, assertTestDb } from './helpers'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { mcpClient, call } from './helpers-mcp'
import { Receiver } from './helpers-receiver'

// An HTTP API run's rerun and resume take concurrency, over MCP control_run and
// REST: the new run's batch size (a resume writes it into the run, as a whole
// number, every other setting kept), which a later rerun without it repeats. A local receiver (tests/e2e/net-shim.cjs)
// holds every answer, so the requests Cubex really has in flight are counted:
// exactly that many come, and no more for 2 s. Out of range, both surfaces
// refuse in the same words. Refusals in detail: unit/http-run-concurrency.test.ts.
const rx = new Receiver()
const PATH = '/concurrency'
const ROWS = 8
let api: APIRequestContext
let v1: APIRequestContext
let mcp: Client

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await rx.start()
  rx.on(PATH, { status: 200, body: '{"ok":"yes"}' })
  api = await authedApi()
  const token = await makeToken(api, ['read', 'write', 'run'], 'http rerun concurrency')
  v1 = await bearer(token)
  mcp = await mcpClient(token, 'http-rerun-concurrency')
})
test.afterAll(async () => { await rx.stop(); await mcp?.close(); await v1?.dispose() })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const hits = () => rx.hitsOn(PATH).length
// The config the run stores, as text, read from the test database; and its batch size.
function storedConfig(runId: string): string {
  const db = new Database(assertTestDb(process.env.DB_PATH), { readonly: true })
  try {
    return db.prepare('SELECT config FROM http_runs WHERE id = ?').pluck().get(runId) as string
  } finally { db.close() }
}
const storedBatchSize = (runId: string): unknown => JSON.parse(storedConfig(runId)).batchSize
// A resume changes the batch size alone, written as a whole number ("batchSize":4, not 4.0).
function expectOnlyBatchSize(before: string, runId: string, n: number) {
  const after = storedConfig(runId)
  expect(after).toContain(`"batchSize":${n}`)
  expect(after).not.toContain(`"batchSize":${n}.`)
  expect(JSON.parse(after)).toEqual({ ...JSON.parse(before), batchSize: n })
}

// Starts a run with every answer held: exactly `n` requests come, and no other for 2 s.
async function inFlight(n: number, start: () => Promise<string>): Promise<string> {
  const before = hits()
  const release = rx.hold([PATH])
  try {
    const runId = await start()
    await rx.waitFor(PATH, before + n)
    for (const until = Date.now() + 2000; Date.now() < until; await sleep(100)) expect(hits() - before).toBe(n)
    return runId
  } finally { release() }
}
const done = async (runId: string) =>
  expect((await waitForTerminal(v1, `/api/v1/http-runs/${runId}`)).status).toBe('completed')
const restRerun = async (runId: string, body: Record<string, unknown>) => {
  const res = await v1.post(`/api/v1/http-runs/${runId}/rerun`, { data: body })
  expect(res.status(), await res.text()).toBe(202)
  return (await res.json()).run_id as string
}
const mcpRerun = async (runId: string, args: Record<string, unknown>) =>
  (await call(mcp, 'control_run', { run_type: 'http', run_id: runId, action: 'rerun', ...args })).run_id as string

// A rerun one at a time, paused while its first request is held, then left to settle.
async function pausedRerun(from: string, pause: (runId: string) => Promise<void>): Promise<string> {
  const before = hits()
  const release = rx.hold([PATH])
  let runId = ''
  try {
    runId = await restRerun(from, { concurrency: 1 })
    await rx.waitFor(PATH, before + 1)
    await pause(runId)
  } finally { release() }
  await rx.settled()
  await expect.poll(async () => (await (await v1.get(`/api/v1/http-runs/${runId}`)).json()).status).toBe('paused')
  return runId
}

test('HTTP API reruns and resumes run with the concurrency asked, and later reruns keep it', async () => {
  test.setTimeout(150_000)
  const { sheetId } = await seedSheet(api, 1)
  const csv = `Name\n${Array.from({ length: ROWS }, (_, i) => `r${i + 1}`).join('\n')}\n`
  expect((await importCsv(api, sheetId, csv, { replaceData: true })).ok()).toBeTruthy()
  const start = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, { data: {
    // POST: Cubex answers a repeated GET from its 5-minute cache, which would send nothing to count.
    url: rx.url(`${PATH}?n={{Name}}`), method: 'POST', master_column_name: 'Call', batch_size: 1,
    response_mapping: [{ json_path: '$.ok', column_name: 'OK' }],
  } })
  expect(start.status(), await start.text()).toBe(202)
  let last = (await start.json()).run_id as string
  await done(last)
  expect(storedBatchSize(last)).toBe(1)

  // Reruns: MCP and REST with concurrency, then each without it repeats the one before.
  for (const [n, rerun] of [
    [3, (id: string) => mcpRerun(id, { mode: 'all', concurrency: 3 })],
    [3, (id: string) => restRerun(id, {})],
    [5, (id: string) => restRerun(id, { mode: 'all', concurrency: 5 })],
    [5, (id: string) => mcpRerun(id, { mode: 'all' })],
  ] as Array<[number, (id: string) => Promise<string>]>) {
    const from = last
    last = await inFlight(n, () => rerun(from))
    expect(storedBatchSize(last)).toBe(n)
    await done(last)
  }

  // Resumes: REST, then MCP, each change a paused run's concurrency before it goes on.
  const restPaused = await pausedRerun(last, async id =>
    expect((await v1.post(`/api/v1/http-runs/${id}/pause`)).status()).toBe(200))
  const restBefore = storedConfig(restPaused)
  await inFlight(4, async () => {
    const res = await v1.post(`/api/v1/http-runs/${restPaused}/resume`, { data: { concurrency: 4 } })
    expect(res.status(), await res.text()).toBe(200)
    return restPaused
  })
  expectOnlyBatchSize(restBefore, restPaused, 4)
  await done(restPaused)
  const mcpPaused = await pausedRerun(restPaused, async id => {
    await call(mcp, 'control_run', { run_type: 'http', run_id: id, action: 'pause' })
  })
  const mcpBefore = storedConfig(mcpPaused)
  await inFlight(2, async () => {
    await call(mcp, 'control_run', { run_type: 'http', run_id: mcpPaused, action: 'resume', concurrency: 2 })
    return mcpPaused
  })
  expectOnlyBatchSize(mcpBefore, mcpPaused, 2)
  await done(mcpPaused)
  last = await inFlight(2, () => restRerun(mcpPaused, {}))
  expect(storedBatchSize(last)).toBe(2)
  await done(last)

  // Out of range: the same words on both surfaces, and no run starts.
  const runs = hits()
  for (const bad of [0, 101, 2.5]) {
    const refused = await mcp.callTool({ name: 'control_run',
      arguments: { run_type: 'http', run_id: last, action: 'rerun', concurrency: bad } })
    expect(refused.isError).toBe(true)
    expect((refused.content as Array<{ text: string }>)[0].text).toBe('Input validation error: Invalid arguments '
      + 'for tool control_run: concurrency: concurrency must be a whole number from 1 to 100.')
    const res = await v1.post(`/api/v1/http-runs/${last}/rerun`, { data: { concurrency: bad } })
    expect([res.status(), await res.json()])
      .toEqual([400, { error: 'concurrency must be a whole number from 1 to 100.' }])
  }
  await sleep(500)
  expect(hits()).toBe(runs)
})
