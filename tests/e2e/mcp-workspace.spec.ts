import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, makeAccessToken, BASE } from './helpers'
import { mcpClient, parseResult } from './helpers-run-results'

// Agent conveniences: export_csv,
// list_runs, sheet caps in get_sheet, and the blank-starter-row import fix.

// test6, deliberately: import_csv has a 5/min PER-USER budget (tools-import.ts)
// and 13 specs share test3 — mcp-structure alone spends 4. This spec's two
// imports then hit an exhausted window, so it passed alone and failed in a
// full-suite run. test6 is otherwise used only by mcp-run-results-authz, which
// imports nothing. Don't move this back to a busy user.

test('export_csv returns the whole sheet in one call', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3)
  const token = await makeAccessToken(api, ['read', 'write'], 'ws-export')
  const client = await mcpClient(token, 'e2e-workspace')

  await client.callTool({
    name: 'add_column', arguments: { sheet_id: sheetId, name: 'city' },
  })
  const rows = parseResult(await client.callTool({
    name: 'read_rows', arguments: { sheet_id: sheetId },
  }))
  await client.callTool({
    name: 'update_cells',
    arguments: {
      sheet_id: sheetId,
      updates: [{ row_id: rows.rows[0].id, data: { city: 'Berlin' } }],
    },
  })

  const csv = parseResult(await client.callTool({
    name: 'export_csv', arguments: { sheet_id: sheetId },
  }))
  expect(typeof csv.csv).toBe('string')
  expect(csv.csv).toContain('city')
  expect(csv.csv).toContain('Berlin')
  expect(csv.sheet_name).toBeTruthy()
  // Header line excluded from row_count, so it means what a caller expects.
  expect(csv.row_count).toBeGreaterThan(0)

  await client.close()
})

test('list_runs finds a run id you no longer hold', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'ws-runs')
  const hdrs = { Authorization: `Bearer ${token}` }
  const client = await mcpClient(token, 'e2e-workspace-runs')

  // Start a run and then deliberately "lose" its id — the dogfood scenario.
  const start = await api.post(`${BASE}/api/v1/sheets/${sheetId}/ai-runs`, {
    headers: hdrs,
    data: { column_name: 'summary', prompt: 'Summarize /val', model: 'openai/gpt-4o-mini' },
  })
  expect(start.status()).toBe(202)
  const lostRunId = (await start.json()).run_id

  const listed = parseResult(await client.callTool({
    name: 'list_runs', arguments: { sheet_id: sheetId },
  }))
  expect(listed.count).toBeGreaterThan(0)
  const found = listed.runs.find((r: any) => r.id === lostRunId)
  expect(found).toBeTruthy()
  // The element must be directly usable with the other run tools.
  expect(found.type).toBe('ai')
  expect(found.sheet_id).toBe(sheetId)
  expect(typeof found.status).toBe('string')

  // A foreign/unknown sheet_id is an error, NOT a silent empty list that reads
  // as "no runs here".
  const foreign = parseResult(await client.callTool({
    name: 'list_runs', arguments: { sheet_id: '00000000-0000-4000-8000-000000000000' },
  }))
  expect(foreign.error).toContain('not found')

  // Workspace-wide listing works without a sheet_id.
  const all = parseResult(await client.callTool({ name: 'list_runs', arguments: {} }))
  expect(all.count).toBeGreaterThan(0)

  await client.close()
})

test('get_sheet reports remaining row/column budget', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3)
  const token = await makeAccessToken(api, ['read'], 'ws-caps')
  const client = await mcpClient(token, 'e2e-workspace-caps')

  const meta = parseResult(await client.callTool({
    name: 'get_sheet', arguments: { sheet_id: sheetId },
  }))
  expect(meta.limits).toBeTruthy()
  expect(meta.limits.max_rows).toBe(1000000) // default MAX_ROWS_PER_SHEET
  expect(meta.limits.max_columns).toBe(200) // default MAX_COLUMNS_PER_SHEET
  // Remaining must be consistent with the counts on the same response, or an
  // agent doing the arithmetic itself would disagree with us.
  expect(meta.limits.rows_remaining).toBe(meta.limits.max_rows - meta.row_count)
  expect(meta.limits.columns_remaining).toBe(meta.limits.max_columns - meta.columns.length)

  await client.close()
})

test('import_csv into a fresh sheet drops the blank starter rows', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const token = await makeAccessToken(api, ['read', 'write'], 'ws-import')
  const client = await mcpClient(token, 'e2e-workspace-import')

  // Only the UI seeds blank starter rows: POST /api/tables/:id/sheets calls
  // createSheetTxn WITHOUT { seed: false }, while every programmatic path
  // (createTable, and createSheet behind /api/v1 + manage_sheet) passes
  // seed:false and starts empty. So the scenario this fix targets is a UI-made
  // tab that an agent later imports into — which is exactly the mixed
  // human/agent workflow the dogfood session ran. Create the tab over the UI
  // route to reproduce it faithfully.
  // Start from an empty workspace like seedSheet() does (manage_table doesn't
  // clear anything), so leftovers from earlier specs can't leak in.
  const existing = await (await api.get(`${BASE}/api/tables`)).json()
  if (Array.isArray(existing)) for (const t of existing) await api.delete(`${BASE}/api/tables/${t.id}`)

  const table = parseResult(await client.callTool({
    name: 'manage_table',
    arguments: { action: 'create', name: `WS_${Date.now()}_${Math.random()}` },
  }))
  expect(table.error, `manage_table create failed: ${JSON.stringify(table)}`).toBeUndefined()
  expect(table.id).toBeTruthy()
  const uiTab = await api.post(`${BASE}/api/tables/${table.id}/sheets`, {
    data: { name: 'Fresh' },
  })
  expect(uiTab.status()).toBeLessThan(300)
  const freshSheetId = (await uiTab.json()).sheets.find((s: any) => s.name === 'Fresh').id

  // Precondition: that tab really does carry the blank starter rows, or this
  // test would pass vacuously against an already-empty sheet.
  const before = parseResult(await client.callTool({
    name: 'read_rows', arguments: { sheet_id: freshSheetId },
  }))
  expect(before.rows).toHaveLength(3)
  expect(before.rows.every((r: any) => Object.values(r.data).every(v => v === ''))).toBe(true)

  const imported = parseResult(await client.callTool({
    name: 'import_csv',
    arguments: { sheet_id: freshSheetId, csv: 'name,city\nAda,Berlin\nGrace,Paris' },
  }))
  expect(imported.rows_imported).toBe(2)
  // The fix: data starts at row 0, and the response SAYS the starter rows went.
  expect(imported.starting_row).toBe(0)
  expect(imported.dropped_blank_starter_rows).toBe(true)

  // Exactly the imported rows survive — no blanks left behind.
  const rows = parseResult(await client.callTool({
    name: 'read_rows', arguments: { sheet_id: freshSheetId },
  }))
  expect(rows.rows).toHaveLength(2)
  expect(rows.rows[0].data.name).toBe('Ada')

  // A SECOND import appends normally — the drop is once, only while pristine.
  const again = parseResult(await client.callTool({
    name: 'import_csv',
    arguments: { sheet_id: freshSheetId, csv: 'name,city\nAlan,London' },
  }))
  expect(again.starting_row).toBe(2)
  expect(again.dropped_blank_starter_rows).toBeUndefined()

  await client.callTool({ name: 'manage_table', arguments: { action: 'delete', table_id: table.id } })
  await client.close()
})

test('export_csv narrows by columns and where — the dogfood A/B-cell task', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const token = await makeAccessToken(api, ['read', 'write'], 'ws-export-filter')
  const client = await mcpClient(token, 'e2e-workspace-filter')

  const existing = await (await api.get(`${BASE}/api/tables`)).json()
  if (Array.isArray(existing)) for (const t of existing) await api.delete(`${BASE}/api/tables/${t.id}`)
  const table = parseResult(await client.callTool({
    name: 'manage_table', arguments: { action: 'create', name: `EXP_${Date.now()}` },
  }))
  const sheetId = table.sheets[0].id

  // A miniature of the real shape: more columns than you want, two test cells.
  const header = 'Email,Company,Test Cell,Subject,Body,Notes'
  const rows = Array.from({ length: 12 }, (_, i) =>
    `p${i}@x.com,Co${i},${i % 2 === 0 ? 'A' : 'B'},Subj${i},Body${i},note${i}`)
  await client.callTool({
    name: 'import_csv', arguments: { sheet_id: sheetId, csv: [header, ...rows].join('\n') },
  })

  // The task that exposed the gap: only cell A, only the columns needed.
  const cellA = parseResult(await client.callTool({
    name: 'export_csv',
    arguments: {
      sheet_id: sheetId,
      columns: ['Email', 'Company', 'Subject', 'Body'],
      where: [{ column: 'Test Cell', operator: 'eq', value: 'A' }],
    },
  }))
  expect(cellA.row_count).toBe(6)
  expect(cellA.columns).toEqual(['Email', 'Company', 'Subject', 'Body'])
  // Header is exactly the projection — no 'Test Cell', no 'Notes'.
  // escapeCsvCell quotes every cell (the formula-injection defense), so compare
  // the PARSED header rather than a raw string.
  const lines = cellA.csv.split('\r\n')
  const headerCells = lines[0].split(',').map((c: string) => c.replace(/^"|"$/g, ''))
  expect(headerCells).toEqual(['Email', 'Company', 'Subject', 'Body'])
  expect(cellA.csv).not.toContain('note')
  expect(lines).toHaveLength(7)  // header + 6

  const cellB = parseResult(await client.callTool({
    name: 'export_csv',
    arguments: {
      sheet_id: sheetId,
      columns: ['Email', 'Company', 'Subject', 'Body'],
      where: [{ column: 'Test Cell', operator: 'eq', value: 'B' }],
    },
  }))
  expect(cellB.row_count).toBe(6)
  // The two exports are disjoint — that's the whole point of two files.
  expect(cellB.csv).not.toBe(cellA.csv)

  // The cost claim, measured rather than asserted: the narrowed export must be
  // materially smaller than the full sheet it replaced.
  const full = parseResult(await client.callTool({
    name: 'export_csv', arguments: { sheet_id: sheetId },
  }))
  expect(full.row_count).toBe(12)
  expect(cellA.csv.length).toBeLessThan(full.csv.length / 2)

  // A filter matching nothing is a valid empty result (header only), NOT an error.
  const none = parseResult(await client.callTool({
    name: 'export_csv',
    arguments: { sheet_id: sheetId, where: [{ column: 'Test Cell', operator: 'eq', value: 'Z' }] },
  }))
  expect(none.row_count).toBe(0)
  expect(none.csv.split('\r\n')).toHaveLength(1)

  // A typo'd column is a clean error, not a CSV silently full of blanks.
  const bad = parseResult(await client.callTool({
    name: 'export_csv', arguments: { sheet_id: sheetId, columns: ['Emial'] },
  }))
  expect(bad.error).toContain('Unknown column')

  await client.callTool({ name: 'manage_table', arguments: { action: 'delete', table_id: table.id } })
  await client.close()
})
