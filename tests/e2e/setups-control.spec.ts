import { test, expect } from '@playwright/test'
import { authedApi, getSheet, makeAccessToken } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'
import { sheetWith, waitSetup, column } from './helpers-setups'

// A setup being used: paused right after its start (the next step waits), then
// resumed; stopped (no later step starts), then used again with the same names
// (it carries on from there); resuming one whose later step reads a saved key
// needs 'secrets'; an AI step starts on the model it was saved with, and used
// again it runs only on rows its column hasn't done (failed rows aren't empty).

test('a setup run pauses between steps, resumes, stops; an AI step starts on its model', async () => {
  test.setTimeout(180_000)
  const api = await authedApi()
  for (const s of (await (await api.get('/api/setups')).json()).setups) await api.delete(`/api/setups/${s.id}`)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'setups-control'))
  const a = await sheetWith(api, null, [{ Website: 'acme.com' }])
  await call(client, 'formula_column', { sheet_id: a.sheetId, column: 'Domain', formula: '{{Website}}?.split(".")[0]' })
  await call(client, 'formula_column', { sheet_id: a.sheetId, column: 'Label', formula: '{{Domain}} + "!"' })
  const setup = await call(client, 'save_setup', { sheet_id: a.sheetId, name: 'Two steps', columns: ['Label'] })
  const b = await sheetWith(api, a.tableId, [{ Website: 'one.com' }, { Website: 'two.com' }, { Website: 'three.com' }])
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  // Paused right after its start: the second step waits, whatever the first does.
  const run = (await call(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: setup.id, estimate_only: false }))
    .setup_run
  expect((await call(client, 'control_setup_run', { setup_run_id: run.id, action: 'pause' })).status).toBe('paused')
  await sleep(2500)
  const paused = await call(client, 'get_setup_run', { setup_run_id: run.id })
  expect(paused.status).toBe('paused')
  expect(paused.steps.find((s: any) => s.column === 'Label').state).toBe('waiting')
  expect((await getSheet(api, b.sheetId)).data.columns).not.toContain('Label')
  await call(client, 'control_setup_run', { setup_run_id: run.id, action: 'resume' })
  expect((await waitSetup(client, run.id)).status).toBe('done')
  expect(await column(api, b.sheetId, 'Label')).toEqual(['one!', 'two!', 'three!'])

  // Stopped right after its start: no later step starts.
  const names2 = { Domain: 'Domain 2', Label: 'Label 2' }
  const again = (await call(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: setup.id, estimate_only: false,
    names: names2 })).setup_run
  expect((await call(client, 'control_setup_run', { setup_run_id: again.id, action: 'cancel' })).status)
    .toBe('cancelled')
  await sleep(2000)
  expect((await getSheet(api, b.sheetId)).data.columns).not.toContain('Label 2')
  // Used again with the same names, it carries on from there.
  const carried = (await call(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: setup.id, estimate_only: false,
    names: names2 })).setup_run
  expect(carried.steps.map((s: any) => s.mode)).toEqual(['again', 'new'])
  expect((await waitSetup(client, carried.id)).status).toBe('done')
  expect(await column(api, b.sheetId, 'Label 2')).toEqual(['one!', 'two!', 'three!'])

  // Resuming a setup whose later step reads a saved key needs 'secrets'.
  const keys = await (await api.get('/api/settings/api-keys')).json()
  for (const k of keys) if (k.name === 'setup_e2e_key2') await api.delete(`/api/settings/api-keys/${k.id}`)
  await api.post('/api/settings/api-keys', { data: { name: 'setup_e2e_key2', key_type: 'api_key',
    key_value: 'e2e-key-value-9876543210' } })
  const secret = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run', 'secrets'], 'setups-sec2'))
  const keyedRun = await call(secret, 'run_http_enrichment', { sheet_id: a.sheetId,
    url: 'https://jsonplaceholder.typicode.com/posts/1?d={{Domain}}', headers: { 'X-Key': '{{setup_e2e_key2}}' },
    master_column_name: 'Keyed', response_mapping: [{ json_path: '$.userId', column_name: 'User id' }] })
  await expect.poll(async () => (await call(secret, 'get_run_status', { run_type: 'http', run_id: keyedRun.run_id }))
    .status, { timeout: 30_000 }).toBe('completed')
  const keyed = await call(secret, 'save_setup', { sheet_id: a.sheetId, name: 'Keyed chain', columns: ['User id'] })
  const keyedRun2 = (await call(secret, 'apply_setup', { sheet_id: b.sheetId, setup_id: keyed.id,
    names: { Domain: 'Domain 3' }, estimate_only: false })).setup_run
  await call(secret, 'control_setup_run', { setup_run_id: keyedRun2.id, action: 'pause' })
  expect(await callError(client, 'control_setup_run', { setup_run_id: keyedRun2.id, action: 'resume' }))
    .toMatch(/secrets/)
  await call(secret, 'control_setup_run', { setup_run_id: keyedRun2.id, action: 'resume' })
  expect((await waitSetup(secret, keyedRun2.id)).status).toBe('done')
  expect(await column(api, b.sheetId, 'User id')).toEqual(['1', '1', '1'])

  // An AI step: started on the model it was saved with (a fake key fails each row for free).
  expect((await api.put('/api/settings/openrouter-key', { data: { apiKey: 'sk-or-v1-invalid-e2e' } })).ok())
    .toBeTruthy()
  try {
    const ai = await call(client, 'run_ai_column', { sheet_id: a.sheetId, column_name: 'Fit',
      prompt: 'Is /domain a fit?', model: 'deepseek/deepseek-v4-flash' })
    await expect.poll(async () => (await call(client, 'get_run_status', { run_type: 'ai', run_id: ai.run_id }))
      .status, { timeout: 30_000 }).toMatch(/completed|failed/)
    const aiSetup = await call(client, 'save_setup', { sheet_id: a.sheetId, name: 'Fit', columns: ['Fit (Output)'],
      include_upstream: false })
    const est = await call(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: aiSetup.id })
    expect(est.estimate.steps[0].kind).toBe('ai')
    const started = (await call(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: aiSetup.id,
      estimate_only: false })).setup_run
    const done = await waitSetup(client, started.id)
    expect(done.steps[0].run_id).toBeTruthy()
    expect((await getSheet(api, b.sheetId)).data.columns).toContain('Fit (Output)')
    // Its rows failed (the fake key): they aren't empty, so using it again has nothing to run...
    const none = await call(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: aiSetup.id })
    expect(none.estimate.steps[0]).toMatchObject({ mode: 'again', rows: 0 })
    // ...until a new row comes in: it runs on that row alone.
    await api.post(`/api/sheets/${b.sheetId}/rows`, { data: { count: 1 } })
    await api.put(`/api/sheets/${b.sheetId}/data`, { data: { updates: [{ rowIndex: 3, columnName: 'Website',
      value: 'four.com' }] } })
    await expect.poll(async () => (await column(api, b.sheetId, 'Domain'))[3], { timeout: 15_000 }).toBe('four')
    const one = await call(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: aiSetup.id })
    expect(one.estimate.steps[0]).toMatchObject({ mode: 'again', rows: 1 })
    const oneRun = (await call(client, 'apply_setup', { sheet_id: b.sheetId, setup_id: aiSetup.id,
      estimate_only: false })).setup_run
    const oneDone = await waitSetup(client, oneRun.id)
    const aiRun = await call(client, 'get_run_status', { run_type: 'ai', run_id: oneDone.steps[0].run_id })
    expect(aiRun.total_rows).toBe(1)
  } finally {
    await api.delete('/api/settings/openrouter-key')
  }
  for (const s of (await (await api.get('/api/setups')).json()).setups) await api.delete(`/api/setups/${s.id}`)
})
