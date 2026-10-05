import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, makeAccessToken, BASE } from './helpers'

// An active AI run's PROMPT INPUTS are now protected from rename/delete
// (the deliberate remainder).
//
// The existing guards only ever protected a run's OUTPUT columns. But the
// runner re-substitutes the stored prompt for EVERY row, so renaming a column
// the prompt reads (/val) mid-run silently feeds "[MISSING: /val]" to every
// remaining row — paid garbage that surfaces only when a human reads the output.
//
// Setup note: the run is PAUSED rather than left running. Without an OpenRouter
// key a started run fails fast, and racing that would make this flaky; 'paused'
// is an active (non-terminal) status, which is exactly what the guards check.


test('an active run\'s prompt input cannot be renamed or deleted', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'input-guard')
  const hdrs = { Authorization: `Bearer ${token}` }

  // The seeded sheet has a 'val' column. Start a run whose prompt READS it, and
  // whose OUTPUT is a different column entirely — so anything blocked here is
  // blocked because of the prompt, not the old output-column guard.
  const start = await api.post(`${BASE}/api/v1/sheets/${sheetId}/ai-runs`, {
    headers: hdrs,
    data: { column_name: 'summary', prompt: 'Summarize /val', model: 'openai/gpt-4o-mini' },
  })
  expect(start.status()).toBe(202)
  const runId = (await start.json()).run_id

  // Pause immediately so the run sits in a stable non-terminal state.
  await api.post(`${BASE}/api/v1/ai-runs/${runId}/pause`, { headers: hdrs })
  const status = await (await api.get(`${BASE}/api/v1/ai-runs/${runId}`, { headers: hdrs })).json()
  // If it already reached a terminal status the guards legitimately won't fire;
  // skip rather than assert something the contract doesn't promise.
  test.skip(!['pending', 'running', 'paused'].includes(status.status),
    `run reached ${status.status} before it could be pinned active`)

  // RENAME the prompt input → blocked, and the message must explain WHY rather
  // than just saying "a run is active" (the user's next question is "which?").
  const rename = await api.patch(`${BASE}/api/v1/sheets/${sheetId}/columns/val`, {
    headers: hdrs, data: { name: 'value' },
  })
  expect(rename.status()).toBe(409)
  const renameErr = (await rename.json()).error
  expect(renameErr).toContain('MISSING')
  expect(renameErr.toLowerCase()).toContain('prompt')

  // DELETE the prompt input → blocked too. Deleting is worse than renaming:
  // there is nothing to reconcile to.
  const del = await api.delete(`${BASE}/api/v1/sheets/${sheetId}/columns/val`, { headers: hdrs })
  expect(del.status()).toBe(409)
  expect((await del.json()).error).toContain('MISSING')

  // A column the prompt does NOT read stays renameable — the guard must be
  // narrow, or every rename on a sheet with any active run would be refused.
  const addOther = await api.post(`${BASE}/api/v1/sheets/${sheetId}/columns`, {
    headers: hdrs, data: { name: 'unrelated' },
  })
  expect(addOther.status()).toBeLessThan(300)
  const renameOther = await api.patch(`${BASE}/api/v1/sheets/${sheetId}/columns/unrelated`, {
    headers: hdrs, data: { name: 'unrelated_renamed' },
  })
  expect(renameOther.status()).toBeLessThan(300)

  // Once the run is cancelled, the input is free again — the guard keys on
  // ACTIVE runs, not on any run that ever referenced the column.
  await api.post(`${BASE}/api/v1/ai-runs/${runId}/cancel`, { headers: hdrs })
  const renameAfter = await api.patch(`${BASE}/api/v1/sheets/${sheetId}/columns/val`, {
    headers: hdrs, data: { name: 'value' },
  })
  expect(renameAfter.status()).toBeLessThan(300)
})
