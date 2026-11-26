import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet, importCsv } from './helpers'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { Receiver } from './helpers-receiver'
import { waitRunsSetUp } from './helpers-enrich'

// Parking (lib/run-park.ts) on the real job queue: the built server's Sidequest backend, its jobs.db, its 4 job
// slots and its own claim order, which tests/unit/run-park.test.ts stands in for. Four slow runs hold every slot
// (their requests kept back), four readers of {{Fit}} are queued behind them, then Fit's rerun behind those. Once
// the slow runs end, the readers take all 4 slots and wait for Fit, which only a free slot can run: they must park
// (give their slots back, snoozed), or nothing goes on. Every run finishes, each reader sends Fit's new value and
// no ⏳, and only after Fit's rerun wrote it. A paused holder: the readers park for longer meanwhile, so another
// run still gets a slot; resumed, the holder finishes and the readers after it.
const rx = new Receiver()
let api: APIRequestContext
let v1: APIRequestContext
const SLOTS = 4

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await rx.start()
  api = await authedApi()
  v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'run park queue spec'))
})
test.afterAll(async () => { await rx.stop(); await v1?.dispose() })

async function sheetWith(csv: string): Promise<string> {
  const { sheetId } = await seedSheet(api, 1)
  expect((await importCsv(api, sheetId, csv, { replaceData: true })).ok()).toBeTruthy()
  return sheetId
}
// An HTTP API run: POST `path` with `body`, its answer's $.v into `into` (none: its $.ok into "<column> ok").
async function start(sheetId: string, column: string, path: string, body: string, into?: string): Promise<string> {
  const res = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, { data: {
    url: rx.url(path), method: 'POST', body, master_column_name: column,
    response_mapping: [into ? { json_path: '$.v', column_name: into }
      : { json_path: '$.ok', column_name: `${column} ok` }],
  } })
  expect(res.status(), await res.text()).toBe(202)
  return (await res.json()).run_id
}
const statusOf = async (id: string) => (await (await v1.get(`/api/v1/http-runs/${id}`)).json()).status as string
// The bodies `reader` sent, as JSON.
const sentBy = (path: string) => rx.hitsOn(path).map(h => JSON.parse(h.body) as { fit: string })

// A sheet of 3 names with Fit filled at v1 by "Fit check", and SLOTS slow runs on it holding every job slot (one
// sheet: seedSheet clears the tables each time).
async function scene(tag: string) {
  rx.on(`/fit-${tag}`, { status: 200, body: '{"v":"v1"}' })
  const sid = await sheetWith('Name\nada\nbob\ncy\n')
  const fit = await start(sid, 'Fit check', `/fit-${tag}`, '{"n":"{{Name}}"}', 'Fit')
  expect((await waitForTerminal(v1, `/api/v1/http-runs/${fit}`)).status).toBe('completed')
  rx.on(`/slow-${tag}`, { status: 200, body: '{"ok":"yes"}' })
  const release = rx.holdPath(`/slow-${tag}`)
  const slow: string[] = []
  for (let i = 0; i < SLOTS; i++) slow.push(await start(sid, `Slow ${i}`, `/slow-${tag}`, '{}'))
  await expect.poll(async () => (await Promise.all(slow.map(statusOf))).every(st => st === 'running'),
    { timeout: 20_000 }).toBe(true)
  return { sid, fit, slow, release }
}
async function readers(sid: string, tag: string): Promise<string[]> {
  rx.on(`/read-${tag}`, { status: 200, body: '{"ok":"yes"}' })
  const ids: string[] = []
  for (let i = 0; i < SLOTS; i++) ids.push(await start(sid, `Read ${i}`, `/read-${tag}`, '{"fit":"{{Fit}}"}'))
  // Each writes its cells in the background after its 202, and the sheet is busy until then: a rerun asked meanwhile
  // is refused ("busy starting a run"), which under the whole suite's load came first.
  await waitRunsSetUp(sid)
  return ids
}
async function rerunFit(fit: string, tag: string): Promise<string> {
  rx.on(`/fit-${tag}`, { status: 200, body: '{"v":"v2"}' })
  const res = await v1.post(`/api/v1/http-runs/${fit}/rerun`, { data: { mode: 'all' } })
  expect(res.status(), await res.text()).toBe(202)
  return (await res.json()).run_id
}

test('every slot taken by readers of a column its queued rerun fills: they park, the rerun runs, then they do',
  async () => {
    test.setTimeout(120_000)
    const s = await scene('a')
    const read = await readers(s.sid, 'a')
    const fit = await rerunFit(s.fit, 'a')
    for (const id of [...read, fit]) expect(await statusOf(id)).toBe('pending')
    s.release()
    for (const id of [...s.slow, fit, ...read]) {
      expect((await waitForTerminal(v1, `/api/v1/http-runs/${id}`, 60_000)).status, id).toBe('completed')
    }
    const sent = sentBy('/read-a')
    expect(sent).toHaveLength(SLOTS * 3)
    expect(sent.every(b => b.fit === 'v2')).toBe(true)
    const lastFit = Math.max(...rx.hitsOn('/fit-a').map(h => h.at))
    expect(rx.hitsOn('/read-a').every(h => h.at >= lastFit)).toBe(true)
  })

test('a paused holder: the parked readers leave a slot free, another run takes it; resumed, all finish',
  async () => {
    test.setTimeout(120_000)
    const s = await scene('b')
    const read = await readers(s.sid, 'b')
    const fit = await rerunFit(s.fit, 'b')
    // The rerun writes its cells in the background after its 202; until then a pause is refused ("still starting"),
    // which under the whole suite's load came first.
    await waitRunsSetUp(s.sid)
    const pause = await v1.post(`/api/v1/http-runs/${fit}/pause`)
    expect(pause.status(), await pause.text()).toBe(200)
    s.release()
    for (const id of s.slow) {
      expect((await waitForTerminal(v1, `/api/v1/http-runs/${id}`, 60_000)).status).toBe('completed')
    }
    // The readers now hold or wait for every slot; parked, they leave one for this run.
    rx.on('/other-b', { status: 200, body: '{"ok":"yes"}' })
    const other = await start(s.sid, 'Other', '/other-b', '{}')
    expect((await waitForTerminal(v1, `/api/v1/http-runs/${other}`, 30_000)).status).toBe('completed')
    expect(rx.hitsOn('/read-b')).toHaveLength(0)
    for (const id of read) expect(await statusOf(id)).not.toBe('completed')
    const resume = await v1.post(`/api/v1/http-runs/${fit}/resume`)
    expect(resume.status(), await resume.text()).toBe(200)
    for (const id of [fit, ...read]) {
      expect((await waitForTerminal(v1, `/api/v1/http-runs/${id}`, 60_000)).status, id).toBe('completed')
    }
    expect(sentBy('/read-b').every(b => b.fit === 'v2')).toBe(true)
  })
