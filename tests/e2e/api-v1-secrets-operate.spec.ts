import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet } from './helpers'
import { JSON_URL, makeToken, bearer, httpConfig, waitForTerminal } from './api-v1-run-helpers'

// Audit finding #1 (secrets-gate bypass): the authoring-time scan freezes runs
// a no-'secrets' PAT AUTHORS, but a run-scope-only PAT could still OPERATE an
// existing permissive run (UI-authored, or authored by a secrets token) that
// references a saved key — resume/rerun would make the worker resolve it. The
// fix gates resume + rerun on the caller's own 'secrets' scope when the run's
// stored config references a saved key.

async function mkKey(api: APIRequestContext, name: string) {
  const keys = await (await api.get('/api/settings/api-keys')).json()
  if (Array.isArray(keys)) for (const k of keys) if (k.name === name) await api.delete(`/api/settings/api-keys/${k.id}`)
  const res = await api.post('/api/settings/api-keys', {
    data: { name, key_type: 'api_key', key_value: 'sk-test-0123456789abcdef' },
  })
  expect(res.ok()).toBeTruthy()
}

test('run-scope PAT cannot resume or rerun a key-referencing HTTP run it did not author', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 30) // many rows → run stays active long enough to pause
  const secrets = await bearer(await makeToken(api, ['read', 'write', 'run', 'secrets'], 'e2e op secrets'))
  const runOnly = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e op run'))

  await mkKey(api, 'crm_key')
  // A run whose config references the saved key, authored with 'secrets' → allow_secrets=1.
  const cfg = httpConfig('https://jsonplaceholder.typicode.com/todos/{{val}}', 'Out', { 'X-Test': 'Bearer /crm_key' })
  const started = await secrets.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { config: cfg, master_column_name: 'KeyRun' },
  })
  expect(started.status()).toBe(202)
  const runId = (await started.json()).run_id

  // Pause it (run scope is enough to pause — pausing resolves no keys).
  const paused = await runOnly.post(`/api/v1/http-runs/${runId}/pause`)
  expect(paused.status()).toBe(200)

  // The run-only token must NOT be able to resume it: resuming would resolve the key.
  const resume = await runOnly.post(`/api/v1/http-runs/${runId}/resume`)
  expect(resume.status()).toBe(403)
  expect((await resume.json()).error).toContain('crm_key')

  // The secrets token still can.
  const resumeOk = await secrets.post(`/api/v1/http-runs/${runId}/resume`)
  expect(resumeOk.status()).toBe(200)
  await waitForTerminal(secrets, `/api/v1/http-runs/${runId}`, 90_000)

  // Rerun by the run-only token is likewise refused (it clones the permissive config).
  const rerun = await runOnly.post(`/api/v1/http-runs/${runId}/rerun`, { data: { mode: 'all' } })
  expect(rerun.status()).toBe(403)
  expect((await rerun.json()).error).toContain('crm_key')

  // A run that does NOT reference a key is operable by run scope alone (no over-blocking).
  const plain = await secrets.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { config: httpConfig(JSON_URL, 'Plain'), master_column_name: 'PlainRun' },
  })
  const plainId = (await plain.json()).run_id
  await waitForTerminal(secrets, `/api/v1/http-runs/${plainId}`, 90_000)
  const plainRerun = await runOnly.post(`/api/v1/http-runs/${plainId}/rerun`, { data: { mode: 'all' } })
  expect(plainRerun.status()).toBe(202)

  // Frozen-clone (TOCTOU): a permissive run referencing a key that
  // DOESN'T exist yet passes the gate (nothing to protect). A run-only rerun of
  // it must produce a clone that stays locked out even after the key appears.
  const dormant = httpConfig(JSON_URL, 'DormantOut', { 'X-Test': '/later_key' })
  const perm = await secrets.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { config: dormant, master_column_name: 'Dormant' },
  })
  expect(perm.status(), `perm start failed: ${await perm.text()}`).toBe(202)
  const permId = (await perm.json()).run_id
  await waitForTerminal(secrets, `/api/v1/http-runs/${permId}`, 90_000)
  // run-only rerun succeeds (no key exists → gate passes) and freezes the clone.
  const frozenRerun = await runOnly.post(`/api/v1/http-runs/${permId}/rerun`, { data: { mode: 'all' } })
  expect(frozenRerun.status()).toBe(202)
  const frozenId = (await frozenRerun.json()).run_id
  await waitForTerminal(runOnly, `/api/v1/http-runs/${frozenId}`, 90_000)
  await mkKey(api, 'later_key') // key now exists — a live lookup WOULD find it
  // The frozen clone sent the token literally, never resolving the key.
  const frozenRec = await (await api.get(`/api/http/jobs/${frozenId}`)).json()
  expect(frozenRec.results[0].request_config).toContain('/later_key')
  expect(frozenRec.results[0].request_config).not.toContain('[REDACTED:later_key]')

  await secrets.dispose(); await runOnly.dispose(); await api.dispose()
})

test('run-scope resume of a dormant-key run freezes it so a later-created key never resolves', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 30)
  const secrets = await bearer(await makeToken(api, ['read', 'write', 'run', 'secrets'], 'e2e op secrets'))
  const runOnly = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e op run'))

  // Permissive run referencing a key that DOESN'T exist yet (gate passes).
  const cfg = httpConfig('https://jsonplaceholder.typicode.com/todos/{{val}}', 'Out', { 'X-Test': 'Bearer /dormant_key' })
  const started = await secrets.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { config: cfg, master_column_name: 'DormRun' },
  })
  expect(started.status()).toBe(202)
  const runId = (await started.json()).run_id

  // Pause, then resume with the run-only token: allowed (no key exists), but it
  // must FREEZE the run so a later-created key can never resolve.
  expect((await runOnly.post(`/api/v1/http-runs/${runId}/pause`)).status()).toBe(200)
  expect((await runOnly.post(`/api/v1/http-runs/${runId}/resume`)).status()).toBe(200)
  await waitForTerminal(runOnly, `/api/v1/http-runs/${runId}`, 90_000)

  // Now the key exists. The frozen run sent the token literally on every row,
  // never resolving/redacting it.
  await api.post('/api/settings/api-keys', {
    data: { name: 'dormant_key', key_type: 'api_key', key_value: 'sk-test-0123456789abcdef' },
  })
  const rec = await (await api.get(`/api/http/jobs/${runId}`)).json()
  expect(rec.results[0].request_config).toContain('/dormant_key')
  expect(rec.results[0].request_config).not.toContain('[REDACTED:dormant_key]')

  await secrets.dispose(); await runOnly.dispose(); await api.dispose()
})
