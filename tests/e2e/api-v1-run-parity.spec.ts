import { test, expect } from '@playwright/test'
import { authedApi, seedSheet } from './helpers'
import { makeToken, bearer } from './api-v1-run-helpers'

// REST run starts share services/run-start-token*.ts with MCP. Before that,
// REST dropped estimate_only (an "estimate" started a billed run) and
// idempotency keys without a word. Also: GET /runs finds a run again, and an
// HTTP template naming no column or saved key is refused before any request.

test('REST: estimate_only is a pure read, Idempotency-Key replays, GET /runs lists the run', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e rest parity'))
  const path = `/api/v1/sheets/${sheetId}/ai-runs`
  const base = { column_name: 'Parity', prompt: 'echo /val', model: 'openai/gpt-4o-mini' }

  const before = await (await v1.get(`/api/v1/sheets/${sheetId}`)).json()
  const est = await v1.post(path, { data: { ...base, estimate_only: true } })
  expect(est.status()).toBe(200)
  const estJson = await est.json()
  expect(estJson.rows_to_process).toBe(2)
  expect(estJson.run_id).toBeUndefined()
  const after = await (await v1.get(`/api/v1/sheets/${sheetId}`)).json()
  expect(after.columns).toEqual(before.columns)
  expect((await (await v1.get(`/api/v1/runs?sheet_id=${sheetId}`)).json()).count).toBe(0)

  const headers = { 'Idempotency-Key': 'rest-k1' }
  const first = await v1.post(path, { data: base, headers })
  expect(first.status()).toBe(202)
  const runId = (await first.json()).run_id
  expect(runId).toBeTruthy()

  // Same key and arguments: the original run, not a second one.
  const replay = await v1.post(path, { data: base, headers })
  expect(replay.status()).toBe(200)
  expect(await replay.json()).toMatchObject({ run_id: runId, replayed: true })
  // Same key, different arguments: refused.
  expect((await v1.post(path, { data: { ...base, prompt: 'other /val' }, headers })).status()).toBe(409)

  const list = await (await v1.get(`/api/v1/runs?sheet_id=${sheetId}`)).json()
  expect(list.runs.map((r: any) => r.id)).toEqual([runId])
  expect(list.runs[0]).toHaveProperty('failed_rows')
  expect((await v1.get('/api/v1/runs?filter=bogus')).status()).toBe(400)

  await v1.post(`/api/v1/ai-runs/${runId}/cancel`)
})

test('REST HTTP run: an unknown {{name}} is refused before anything is sent', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 1)
  const v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e rest http template'))
  const data = {
    url: 'https://jsonplaceholder.typicode.com/todos/{{nosuch}}',
    response_mapping: [{ json_path: '$.title', column_name: 'Title' }],
  }

  for (const body of [data, { ...data, estimate_only: true }]) {
    const res = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, { data: body })
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toContain('{{nosuch}}')
  }
  const tooWide = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { ...data, url: 'https://jsonplaceholder.typicode.com/todos/{{val}}', batch_size: 999 },
  })
  expect(tooWide.status()).toBe(400)
  expect((await tooWide.json()).error).toContain('batch_size')
  const meta = await (await v1.get(`/api/v1/sheets/${sheetId}`)).json()
  expect(meta.columns).toEqual(['val'])
  expect((await (await v1.get(`/api/v1/runs?sheet_id=${sheetId}`)).json()).count).toBe(0)
})

test('REST: the run-start limit answers 429 with Retry-After and its own RateLimit headers', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 1)
  const v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e run-start window'))
  // Previews take a run-start slot but create nothing; with no OpenRouter key
  // saved each one is a clean 400.
  const body = { column_name: 'Win', prompt: 'echo /val', model: 'openai/gpt-4o-mini', preview_rows: 1 }
  const first = await v1.post(`/api/v1/sheets/${sheetId}/ai-runs`, { data: body })
  expect(first.status()).toBe(400)
  expect((await first.json()).error).toContain('OpenRouter API key')
  for (let i = 1; i < 30; i++) await v1.post(`/api/v1/sheets/${sheetId}/ai-runs`, { data: body })

  const limited = await v1.post(`/api/v1/sheets/${sheetId}/ai-runs`, { data: body })
  expect(limited.status()).toBe(429)
  const h = limited.headers()
  expect(Number(h['retry-after'])).toBeGreaterThan(0)
  expect(h['ratelimit-limit']).toBe('30')
  expect(h['ratelimit-remaining']).toBe('0')
  const json = await limited.json()
  expect(json.retry_after_seconds).toBe(Number(h['retry-after']))
  expect(json.error).toMatch(/Try again in \d+ seconds?/)

  // An estimate is a pure read: never limited.
  const est = await v1.post(`/api/v1/sheets/${sheetId}/ai-runs`, { data: { ...body, preview_rows: undefined, estimate_only: true } })
  expect(est.status()).toBe(200)
})
