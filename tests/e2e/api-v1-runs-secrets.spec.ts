import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, seedSheet } from './helpers'
import { JSON_URL, makeToken, bearer, httpConfig, waitForTerminal } from './api-v1-run-helpers'

// /api/v1 Phase 2 — the 'secrets' scope gate (design doc §2): a config whose
// template tokens reference a saved api_key requires 'secrets' at start, AND
// the granted policy is frozen onto the run (http_runs.allow_secrets,
// migration 034) so a run authored WITHOUT it can never resolve keys created
// later — not even via rerun (the TOCTOU finding).

async function mkKey(api: APIRequestContext, name: string) {
  const keys = await (await api.get('/api/settings/api-keys')).json()
  if (Array.isArray(keys)) for (const k of keys) if (k.name === name) await api.delete(`/api/settings/api-keys/${k.id}`)
  const res = await api.post('/api/settings/api-keys', {
    data: { name, key_type: 'api_key', key_value: 'sk-test-0123456789abcdef' },
  })
  expect(res.ok()).toBeTruthy()
}

test("v1 secrets gate: key refs need 'secrets'; no-secrets runs stay frozen out of later-created keys", async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 1)
  const run = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e v1 run'))
  const secrets = await bearer(await makeToken(api, ['read', 'write', 'run', 'secrets'], 'e2e v1 secrets'))

  // (1) Config referencing an EXISTING key: run-scope token → 403; +secrets → 202.
  await mkKey(api, 'exfil_key')
  const cfg = httpConfig(JSON_URL, 'S1', { 'X-Test': 'Bearer /exfil_key' })
  const blocked = await run.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { config: cfg, master_column_name: 'Gate' },
  })
  expect(blocked.status()).toBe(403)
  expect((await blocked.json()).error).toContain("'secrets' scope")

  const allowed = await secrets.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { config: cfg, master_column_name: 'Gate' },
  })
  expect(allowed.status()).toBe(202)
  const allowedId = (await allowed.json()).run_id
  await waitForTerminal(secrets, `/api/v1/http-runs/${allowedId}`)
  // The secrets-scope run resolved the key: its persisted request record
  // carries the redaction marker, never the literal key text.
  const withKey = await (await api.get(`/api/http/jobs/${allowedId}`)).json()
  expect(withKey.results[0].request_config).toContain('[REDACTED:exfil_key]')

  // (2) TOCTOU freeze: a run-scope start referencing a key that DOESN'T exist
  // yet passes the scan (nothing to protect) — and must stay locked out of the
  // key even after the user creates it and the run is re-run.
  const frozen = await run.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { config: httpConfig(JSON_URL, 'S2', { 'X-Test': '/late_key' }), master_column_name: 'Frozen' },
  })
  expect(frozen.status()).toBe(202)
  const frozenId = (await frozen.json()).run_id
  await waitForTerminal(run, `/api/v1/http-runs/${frozenId}`)

  await mkKey(api, 'late_key') // the key now exists — a live lookup WOULD find it
  const rerun = await run.post(`/api/v1/http-runs/${frozenId}/rerun`, { data: { mode: 'all' } })
  expect(rerun.status()).toBe(202)
  const rerunId = (await rerun.json()).run_id
  await waitForTerminal(run, `/api/v1/http-runs/${rerunId}`)
  // allow_secrets=0 was copied onto the rerun: the template token was sent
  // LITERALLY (no key substitution, no redaction marker).
  const noKey = await (await api.get(`/api/http/jobs/${rerunId}`)).json()
  expect(noKey.results[0].request_config).toContain('/late_key')
  expect(noKey.results[0].request_config).not.toContain('[REDACTED:late_key]')

  await run.dispose(); await secrets.dispose(); await api.dispose()
})
