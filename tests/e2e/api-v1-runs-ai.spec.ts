import { test, expect } from '@playwright/test'
import { authedApi, seedSheet } from './helpers'
import { makeToken, bearer, waitForTerminal } from './api-v1-run-helpers'

// /api/v1 Phase 2 — AI runs + scope enforcement + models passthrough. The seed
// user has no OpenRouter key, so a started AI run fails FAST — exactly what
// the status/error_message/rerun assertions need (no external AI spend).

test.describe.configure({ mode: 'serial' })

test('v1 AI run: no-model 400; failed run carries error_message; rerun; scopes enforced', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const run = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e v1 run'))
  const noRun = await bearer(await makeToken(api, ['read', 'write'], 'e2e v1 norun'))

  // Scope gate: write-only token cannot start runs.
  const denied = await noRun.post(`/api/v1/sheets/${sheetId}/ai-runs`, {
    data: { column_name: 'ai', prompt: 'echo /val', model: 'openai/gpt-4o-mini' },
  })
  expect(denied.status()).toBe(403)
  expect((await denied.json()).error).toContain("'run' scope")

  // No explicit model, no sheet/account default → 400 (never a fallback).
  const noModel = await run.post(`/api/v1/sheets/${sheetId}/ai-runs`, {
    data: { column_name: 'ai', prompt: 'echo /val' },
  })
  expect(noModel.status()).toBe(400)
  expect((await noModel.json()).error).toContain('No AI model selected')

  // With a model the run starts, then fails fast (no OpenRouter key) — the
  // failure reason must surface via the status endpoint.
  const start = await run.post(`/api/v1/sheets/${sheetId}/ai-runs`, {
    data: { column_name: 'ai', prompt: 'echo /val', model: 'openai/gpt-4o-mini' },
  })
  expect(start.status()).toBe(202)
  const started = await start.json()
  expect(started.output_column).toBe('ai (Output)')
  expect(started.data_column).toBeNull()
  const done = await waitForTerminal(run, `/api/v1/ai-runs/${started.run_id}`)
  expect(done.status).toBe('failed')
  expect(done.error_message).toBeTruthy()

  // Rerun by run id needs an explicit mode ('missing' = empty/failed rows = all
  // here) → new failed run; the original is then superseded, and the 409 names
  // the latest run.
  const rerun = await run.post(`/api/v1/ai-runs/${started.run_id}/rerun`, { data: { mode: 'missing' } })
  expect(rerun.status()).toBe(202)
  const rerunId = (await rerun.json()).run_id
  await waitForTerminal(run, `/api/v1/ai-runs/${rerunId}`)
  const stale = await run.post(`/api/v1/ai-runs/${started.run_id}/rerun`, { data: { mode: 'missing' } })
  expect(stale.status()).toBe(409)
  expect((await stale.json()).error).toContain(rerunId)

  // read scope can see status but cannot control.
  const ro = await bearer(await makeToken(api, ['read'], 'e2e v1 ro'))
  expect((await ro.get(`/api/v1/ai-runs/${started.run_id}`)).status()).toBe(200)
  expect((await ro.post(`/api/v1/ai-runs/${rerunId}/rerun`, { data: {} })).status()).toBe(403)

  // Models passthrough works for any read token.
  const models = await ro.get('/api/v1/models')
  expect(models.status()).toBe(200)
  expect((await models.json()).models.length).toBeGreaterThan(10)

  await run.dispose(); await noRun.dispose(); await ro.dispose(); await api.dispose()
})
