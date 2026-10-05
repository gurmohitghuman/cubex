import { test, expect } from '@playwright/test'
import { authedApi, seedSheet } from './helpers'
import { makeToken, bearer } from './api-v1-run-helpers'

// Audit finding #5: renaming/deleting an AI-output column must reconcile
// ai_runs.column_name, or a NEW plain column reusing the old name gets
// misclassified as AI output (getColumnTypes) and a stale-prompt rerun
// overwrites its data. These drive the API to assert the reconciliation.
// The seed user has no OpenRouter key, so AI runs fail fast — enough to
// create the ai_runs row whose name must be reconciled.

test('renaming an AI-output column reconciles ai_runs so rerun follows the new name', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e cascade'))

  // Start an AI run → creates "ai (Output)" + an ai_runs row, then fails (no key).
  const start = await v1.post(`/api/v1/sheets/${sheetId}/ai-runs`, {
    data: { column_name: 'ai', prompt: 'echo /val', model: 'openai/gpt-4o-mini' },
  })
  expect(start.status()).toBe(202)
  const runId = (await start.json()).run_id
  // Wait for it to leave active state so rename isn't blocked by the active-run guard.
  for (let i = 0; i < 40; i++) {
    const s = (await (await v1.get(`/api/v1/ai-runs/${runId}`)).json()).status
    if (['failed', 'completed', 'cancelled'].includes(s)) break
    await new Promise(r => setTimeout(r, 500))
  }

  // Rename the output column via the UI route (PUT /:id/columns/:name {newName}).
  const rename = await api.put(`/api/sheets/${sheetId}/columns/${encodeURIComponent('ai (Output)')}`, {
    data: { newName: 'Renamed (Output)' },
  })
  expect(rename.ok(), `rename failed: ${await rename.text()}`).toBeTruthy()

  // Rerun by the NEW base name resolves (the ai_runs row followed the rename).
  const rerunNew = await api.post('/api/ai/rerun', {
    data: { sheetId, baseColumnName: 'Renamed' },
  })
  expect(rerunNew.status(), `rerun-by-new-name failed: ${await rerunNew.text()}`).toBe(200)

  // Rerun by the OLD base name 404s — the stale association is gone.
  const rerunOld = await api.post('/api/ai/rerun', {
    data: { sheetId, baseColumnName: 'ai' },
  })
  expect(rerunOld.status()).toBe(404)

  await v1.dispose(); await api.dispose()
})

test('deleting an AI-output column tombstones ai_runs so a reused name is not misclassified', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e cascade'))

  const start = await v1.post(`/api/v1/sheets/${sheetId}/ai-runs`, {
    data: { column_name: 'gone', prompt: 'echo /val', model: 'openai/gpt-4o-mini' },
  })
  const runId = (await start.json()).run_id
  for (let i = 0; i < 40; i++) {
    const s = (await (await v1.get(`/api/v1/ai-runs/${runId}`)).json()).status
    if (['failed', 'completed', 'cancelled'].includes(s)) break
    await new Promise(r => setTimeout(r, 500))
  }

  // Delete the AI-output column.
  const del = await api.delete(`/api/sheets/${sheetId}/columns/${encodeURIComponent('gone (Output)')}`)
  expect(del.ok(), `delete failed: ${await del.text()}`).toBeTruthy()

  // Recreate a plain column with the SAME name; it must NOT be treated as an
  // AI-output column (types map should not classify it), so a rerun by that
  // base name 404s instead of resurrecting + overwriting it.
  const addCol = await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'gone (Output)' } })
  expect(addCol.ok()).toBeTruthy()
  const rerunResurrect = await api.post('/api/ai/rerun', {
    data: { sheetId, baseColumnName: 'gone' },
  })
  expect(rerunResurrect.status()).toBe(404)

  await v1.dispose(); await api.dispose()
})
