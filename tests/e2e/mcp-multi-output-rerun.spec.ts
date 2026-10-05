import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// control_run rerun on a structured (output_columns) run: a NEW run refills the
// same typed columns on the chosen rows, and the modes read the "(Status)"
// column. No OpenRouter key here, so each run fails as a whole and clears its
// placeholders: the status cells end blank, which is what "empty" picks up.

const OUTPUT_COLUMNS = [
  { column_name: 'Fit', type: 'number', description: '1 to 10' },
  { column_name: 'Why', type: 'string', description: 'One sentence' },
]
const pause = () => new Promise(r => setTimeout(r, 250))

function parseResult(res: { content?: Array<{ type: string; text?: string }> }): any {
  const text = res.content?.find(c => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

test('control_run reruns a structured run into the same columns', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3)
  const client = new Client({ name: 'e2e-structured-rerun', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${await makeAccessToken(api, ['read', 'write', 'run'], 'e2e structured rerun')}` } },
  }))
  const call = async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<any>
  const rows = async () => parseResult(await call('read_rows', { sheet_id: sheetId })).rows as Array<{ id: string; data: Record<string, string> }>
  const settle = async (runId: string) => {
    for (let i = 0; i < 80; i++) {
      const s = parseResult(await call('get_run_status', { run_type: 'ai', run_id: runId }))
      if (['completed', 'failed', 'cancelled'].includes(s?.status) && !JSON.stringify(await rows()).includes('⏳')) return s
      await pause()
    }
    throw new Error(`run ${runId} did not settle`)
  }
  // A stopped run frees its columns a moment after its last ⏳ is cleared.
  const whenFree = async <T>(attempt: () => Promise<T>, busy: (r: T) => boolean): Promise<T> => {
    for (let i = 0; i < 20; i++) {
      const r = await attempt()
      if (!busy(r)) return r
      await pause()
    }
    throw new Error('columns stayed busy')
  }
  const rerun = (runId: string, how: Record<string, unknown>) => whenFree(
    () => call('control_run', { run_type: 'ai', run_id: runId, action: 'rerun', ...how }),
    r => !!r.isError && JSON.stringify(r.content).includes('still clearing'))
  const menuRerun = (data: Record<string, unknown>) => whenFree(
    () => api.post('/api/ai/rerun', { data: { sheetId, ...data } }), r => r.status() === 409)

  const started = parseResult(await call('run_ai_column', {
    sheet_id: sheetId, column_name: 'Score', prompt: 'Rate /val', model: 'openai/gpt-4o-mini', output_columns: OUTPUT_COLUMNS,
  }))
  expect(started.status_column).toBe('Score (Status)')
  await settle(started.run_id)

  // Nothing is ❌, so "errored" has no rows; one ❌ status cell gives it one.
  const none = await rerun(started.run_id, { mode: 'errored' })
  expect(none.isError).toBeTruthy()
  expect(JSON.stringify(none.content)).toContain('No target rows')
  const [, second] = await rows()
  await call('update_cells', { sheet_id: sheetId, row_id: second.id, data: { 'Score (Status)': '❌ Error: test' } })
  const errored = parseResult(await rerun(started.run_id, { mode: 'errored' }))
  expect(errored.run_id).not.toBe(started.run_id)
  const erroredStatus = await settle(errored.run_id)
  expect(erroredStatus.column_name).toBe('Score (Status)')
  expect(erroredStatus.output_columns).toEqual(['Fit', 'Why'])
  expect(erroredStatus.target_row_count).toBe(1)

  // The first run is superseded; the refusal names the run to use instead.
  const stale = await rerun(started.run_id, { mode: 'empty' })
  expect(stale.isError).toBeTruthy()
  expect(JSON.stringify(stale.content)).toContain(errored.run_id)

  // "empty" picks every blank status cell; row_ids exactly the rows named.
  const empty = parseResult(await rerun(errored.run_id, { mode: 'empty' }))
  expect((await settle(empty.run_id)).target_row_count).toBe(3)
  const [first] = await rows()
  const picked = parseResult(await rerun(empty.run_id, { row_ids: [first.id] }))
  expect((await settle(picked.run_id)).target_row_count).toBe(1)

  // The sheet menu's "Run Missing or Errors" names the header clicked: a typed
  // column reruns the run that owns it. A page sending only the base name still
  // reaches it through the status column's base.
  for (const data of [{ baseColumnName: 'Why', columnName: 'Why' }, { baseColumnName: 'Score' }]) {
    const res = await menuRerun(data)
    expect(res.ok()).toBeTruthy()
    const s = await settle((await res.json()).runId)
    expect(s.output_columns).toEqual(['Fit', 'Why'])
    expect(s.target_row_count).toBe(3)
  }

  // The menu's "Run All Rows" sends mode 'all': every row, a ✅ one included
  // (the default, missing, would skip it). An unknown mode is refused.
  const [done] = await rows()
  await call('update_cells', { sheet_id: sheetId, row_id: done.id, data: { 'Score (Status)': '✅' } })
  const all = await menuRerun({ baseColumnName: 'Why', columnName: 'Why', mode: 'all' })
  expect((await settle((await all.json()).runId)).target_row_count).toBe(3)
  const badMode = await api.post('/api/ai/rerun', { data: { sheetId, baseColumnName: 'Why', mode: 'everything' } })
  expect(badMode.status()).toBe(400)

  // Renamed "Score (Output)", the status column still reruns as a structured
  // run (by id and from the menu), and a single-column run can't take it over.
  await whenFree(() => call('rename_column', { sheet_id: sheetId, column: 'Score (Status)', new_name: 'Score (Output)' }), r => !!r.isError)
  const latest = parseResult(await call('list_runs', { sheet_id: sheetId, limit: 1 })).runs[0]
  const renamed = parseResult(await rerun(latest.id, { mode: 'empty' }))
  const renamedStatus = await settle(renamed.run_id)
  expect(renamedStatus.column_name).toBe('Score (Output)')
  expect(renamedStatus.output_columns).toEqual(['Fit', 'Why'])
  const viaMenu = await menuRerun({ baseColumnName: 'Score' })
  expect((await settle((await viaMenu.json()).runId)).output_columns).toEqual(['Fit', 'Why'])
  const takeover = await whenFree(
    () => call('run_ai_column', { sheet_id: sheetId, column_name: 'Score', prompt: 'Rate /val', model: 'openai/gpt-4o-mini' }),
    r => JSON.stringify(r.content).includes('still clearing'))
  expect(takeover.isError).toBeTruthy()
  expect(JSON.stringify(takeover.content)).toContain('fills several columns')

  // Every rerun wrote into the run's own columns: none added, nothing left on ⏳.
  const sheet = parseResult(await call('get_sheet', { sheet_id: sheetId }))
  expect(sheet.columns).toEqual(['val', 'Fit', 'Why', 'Score (Output)'])
  expect(JSON.stringify(await rows())).not.toContain('⏳')
  await client.close()
})
