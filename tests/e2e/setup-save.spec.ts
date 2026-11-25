import { test, expect } from '@playwright/test'
import { authedApi, makeAccessToken, seedSheet } from './helpers'
import { mockTreg } from './helpers-treg'
import { freshTreg, readDb, seedLeadRows } from './helpers-enrich'
import { call, callError, mcpClient } from './helpers-mcp'

// Saving a column's setup without running it (save_only; services/column-setup-save.ts): the setup becomes the
// column's newest, nothing runs, nothing is billed, no cell changes, History says so, and the run lists leave it
// out. AI and HTTP API columns over MCP, REST and the app's routes; enrichment and waterfall columns over MCP
// (treg is the stand-in). What each refuses with it, and an HTTP API start that names an existing column.

const detail = (sheet: any, name: string) => sheet.column_details.find((d: any) => d.name === name)
const runsOn = (sheetId: string, table: 'ai_runs' | 'http_runs'): Array<{ setup_only: number; status: string }> =>
  readDb(db => db.prepare(`SELECT setup_only, status FROM ${table} WHERE sheet_id = ? ORDER BY rowid`).all(sheetId))
const cellsOf = (sheetId: string): string[] =>
  readDb(db => db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sheetId))

test('AI column: save_only stores the setup, runs nothing, and refuses what only a run takes', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e setup save'))
  const cells = cellsOf(sheetId)

  const saved = await call(client, 'run_ai_column', {
    sheet_id: sheetId, column_name: 'Summary', prompt: 'Summarize /val', model: 'openai/gpt-4o-mini', save_only: true,
  })
  expect(saved.saved).toBe(true)
  expect(saved.run_id).toEqual(expect.any(String))
  expect(saved.output_column).toBe('Summary (Output)')
  expect(saved.changed[0].columns).toEqual(['Summary (Output)'])
  expect(saved.changed[0].rows).toBe(0)
  let sheet = await call(client, 'get_sheet', { sheet_id: sheetId })
  expect(sheet.columns).toContain('Summary (Output)')
  expect(detail(sheet, 'Summary (Output)').fill).toMatchObject({ run_status: 'saved', prompt: 'Summarize /val' })
  expect(sheet.active_runs).toEqual([])
  expect(cellsOf(sheetId)).toEqual(cells)
  expect((await call(client, 'list_runs', { sheet_id: sheetId })).runs).toEqual([])

  // Saved again with another prompt, from the app's route: the newest setup is the new one.
  const app = await api.post('/api/ai/run', { data: {
    sheetId, columnName: 'Summary', prompt: 'Describe /val in a word', model: 'openai/gpt-4o-mini', saveOnly: true,
  } })
  expect(app.status()).toBe(200)
  expect(await app.json()).toMatchObject({ saved: true, message: 'Setup saved. Nothing ran.' })
  sheet = await call(client, 'get_sheet', { sheet_id: sheetId })
  expect(detail(sheet, 'Summary (Output)').fill.prompt).toBe('Describe /val in a word')
  expect(runsOn(sheetId, 'ai_runs')).toEqual([{ setup_only: 3, status: 'completed' },
    { setup_only: 3, status: 'completed' }])
  expect(cellsOf(sheetId)).toEqual(cells)

  // History names the column and says nothing ran.
  const history = await call(client, 'get_sheet_history', { sheet_id: sheetId })
  const lines = history.changes.filter((c: any) => c.action === 'setup_saved')
  expect(lines).toHaveLength(2)
  expect(lines[0]).toMatchObject({ column: 'Summary (Output)', via: expect.any(String) })
  expect(lines[0].summary).toBe('Saved a new setup for the AI column "Summary (Output)" without running it')

  // Refused with what only a run takes, before anything is written.
  const base = { sheet_id: sheetId, column_name: 'Other', prompt: 'Hi /val', model: 'openai/gpt-4o-mini',
    save_only: true }
  expect(await callError(client, 'run_ai_column', { ...base, estimate_only: true })).toContain('can\'t go together')
  expect(await callError(client, 'run_ai_column', { ...base, preview_rows: 2 })).toContain('preview_rows is for a run')
  expect(await callError(client, 'run_ai_column', { ...base, idempotency_key: 'k-save' }))
    .toContain('idempotency_key is for a run')
  expect(await callError(client, 'run_ai_column', { ...base, output_columns: [
    { column_name: 'Score', type: 'number', description: 'a score' }] })).toContain('several columns')
  expect((await call(client, 'get_sheet', { sheet_id: sheetId })).columns).not.toContain('Other (Output)')

  // REST answers 200 (nothing started), not 202.
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'e2e setup save rest')
  const rest = await api.post(`/api/v1/sheets/${sheetId}/ai-runs`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { column_name: 'Rest', prompt: 'Hi /val', model: 'openai/gpt-4o-mini', save_only: true },
  })
  expect(rest.status()).toBe(200)
  expect((await rest.json()).saved).toBe(true)
})

test('HTTP API column: a new setup only by save_only; a start naming it is refused, saying how', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e setup save http'))
  const cells = cellsOf(sheetId)
  const first = await call(client, 'run_http_enrichment', {
    sheet_id: sheetId, master_column_name: 'Lookup', url: 'https://api.example.test/one?q={{val}}',
    response_mapping: [{ json_path: '$.x', column_name: 'X' }], save_only: true,
  })
  expect(first).toMatchObject({ saved: true, master_column: 'Lookup', mapped_columns: ['X'] })
  expect(cellsOf(sheetId)).toEqual(cells)

  // A start that would run on it is refused: one mistyped name must not replace a setup and run every row.
  expect(await callError(client, 'run_http_enrichment', {
    sheet_id: sheetId, master_column_name: 'Lookup', url: 'https://api.example.test/two?q={{val}}',
    response_mapping: [{ json_path: '$.x', column_name: 'X' }],
  })).toContain('save the new setup without running')

  // A new setup over REST: another URL and a new mapped column; X stays as a column.
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'e2e setup save http rest')
  const rest = await api.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { master_column_name: 'Lookup', url: 'https://api.example.test/two?q={{val}}',
      response_mapping: [{ json_path: '$.y', column_name: 'Y' }], save_only: true },
  })
  expect(rest.status()).toBe(200)
  expect(await rest.json()).toMatchObject({ saved: true, mapped_columns: ['Y'] })
  const sheet = await call(client, 'get_sheet', { sheet_id: sheetId })
  expect(sheet.columns).toEqual(expect.arrayContaining(['Lookup', 'X', 'Y']))
  expect(detail(sheet, 'Lookup').fill)
    .toMatchObject({ run_status: 'saved', url: 'https://api.example.test/two?q={{val}}' })
  expect(runsOn(sheetId, 'http_runs').map(r => r.setup_only)).toEqual([3, 3])
  expect(cellsOf(sheetId)).toEqual(cells)
  const links = readDb(db => db.prepare(`SELECT extracted_column_name FROM http_column_associations
    WHERE sheet_id = ? AND master_column_name = 'Lookup'`).pluck().all(sheetId))
  expect(links).toEqual(['Y'])

  // The column's rerun runs the saved setup: the setup's run_id is the one control_run takes.
  const setupId = detail(sheet, 'Lookup').fill.run_id
  const rerun = await call(client, 'control_run', { run_type: 'http', run_id: setupId, action: 'rerun' })
  expect(rerun.run_id).not.toBe(setupId)
  const config = JSON.parse(readDb(db => db.prepare('SELECT config FROM http_runs WHERE id = ?').pluck()
    .get(rerun.run_id)))
  expect(config.requestConfig.url).toBe('https://api.example.test/two?q={{val}}')
  expect(config.responseMapping.map((m: any) => m.columnName)).toEqual(['Y'])
  await call(client, 'control_run', { run_type: 'http', run_id: rerun.run_id, action: 'cancel' }).catch(() => null)
})

test('enrichment and waterfall columns: save_only calls no provider and keeps every cell', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedLeadRows(api, [
    { Name: 'Maya Chen', Website: 'https://stripe.com' }, { Name: 'Leo Martins', Website: 'notion.so' },
  ])
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e setup save enrich'))
  const cells = cellsOf(sheetId)
  const tregCalls = async () => (await mockTreg.requests()).filter(r => r.path.startsWith('/call/')).length

  const enrich = await call(client, 'run_enrichment', {
    sheet_id: sheetId, tool_id: 'treg.people.email.find', preset: 'verified_email', column_name: 'Work email',
    inputs: { full_name: 'Name', domain: 'Website' }, save_only: true,
  })
  expect(enrich).toMatchObject({ saved: true, status_column: 'Work email', test_rows: null })
  expect(enrich.output_columns.length).toBeGreaterThan(0)
  // Saved again on the column a save made: add_to_column, another "Only run if".
  const again = await call(client, 'run_enrichment', {
    sheet_id: sheetId, tool_id: 'treg.people.email.find', preset: 'verified_email', column_name: 'Work email',
    add_to_column: true, inputs: { full_name: 'Name', domain: 'Website' }, run_if: '{{Name}} is not empty',
    save_only: true,
  })
  expect(again).toMatchObject({ saved: true, run_if: '{{Name}} is not empty' })

  const wf = await call(client, 'waterfall_column', {
    sheet_id: sheetId, column_name: 'Email WF', template: 'work_email',
    inputs: { full_name: 'Name', domain: 'Website' }, save_only: true,
  })
  expect(wf).toMatchObject({ saved: true, result_column: 'Email WF' })
  expect(await callError(client, 'waterfall_column', {
    sheet_id: sheetId, column_name: 'Email WF 2', template: 'work_email',
    inputs: { full_name: 'Name', domain: 'Website' }, save_only: true, estimate_only: true,
  })).toContain('can\'t go together')

  const sheet = await call(client, 'get_sheet', { sheet_id: sheetId })
  expect(detail(sheet, 'Work email').fill.run_status).toBe('saved')
  expect(detail(sheet, 'Email WF').fill.run_status).toBe('saved')
  expect(sheet.active_runs).toEqual([])
  expect(await tregCalls()).toBe(0)
  expect(runsOn(sheetId, 'http_runs').every(r => r.setup_only === 3 && r.status === 'completed')).toBe(true)
  expect(cellsOf(sheetId)).toEqual(cells)
})
