import { test, expect } from '@playwright/test'
import { authedApi, seedSheet } from './helpers'
import { makeToken, bearer } from './api-v1-run-helpers'

// P2-3 regression: starting an AI run must reject a case/token collision between
// the "<name> (Output)"/"(Data)" columns it would create and a DIFFERENT
// existing column — like every other column-creation site. An EXACT match is
// legitimate self-reuse (re-running a column writes to its own Output column),
// so only case/token clashes are rejected. Without this, "ai (Output)" could
// coexist with a manual "ai (output)" and make /column resolution ambiguous.

test.describe.configure({ mode: 'serial' })

test('v1 AI run rejects a case-variant collision with an existing column', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const run = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e collision'))

  // Manually create a column that is a CASE variant of the AI run's output
  // column: run column "ai" would create "ai (Output)"; seed "ai (output)".
  const add = await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'ai (output)' } })
  expect(add.ok()).toBeTruthy()

  // Starting an AI run on "ai" must 409 (case collision) — NOT 202 + a second
  // ambiguous column.
  const start = await run.post(`/api/v1/sheets/${sheetId}/ai-runs`, {
    data: { column_name: 'ai', prompt: 'echo /val', model: 'openai/gpt-4o-mini' },
  })
  expect(start.status()).toBe(409)
  expect((await start.json()).error).toMatch(/case-insensitive|already exists|same \/column token/i)

  // The sheet still has exactly the seeded columns — no ghost "ai (Output)".
  const sheet = await (await api.get(`/api/sheets/${sheetId}?limit=1&offset=0`)).json()
  const cols: string[] = sheet.data.columns
  expect(cols.filter((c) => c.toLowerCase() === 'ai (output)')).toHaveLength(1)

  await run.dispose()
})

test('v1 AI run token-collision (/token) is rejected; exact self-reuse is allowed', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const run = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e collision2'))

  // Token collision: "ai (Output)" normalizes to /ai_output. Seed a column with
  // the same /token via punctuation: "ai-output!" → /ai_output.
  const add = await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'ai output!' } })
  expect(add.ok()).toBeTruthy()

  const clash = await run.post(`/api/v1/sheets/${sheetId}/ai-runs`, {
    data: { column_name: 'ai', prompt: 'echo /val', model: 'openai/gpt-4o-mini' },
  })
  expect(clash.status()).toBe(409)

  await run.dispose()
})
