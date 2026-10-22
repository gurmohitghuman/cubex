import { test, expect } from '@playwright/test'
import { authedApi, makeAccessToken } from './helpers'
import { freshTreg, rowsOf, seedCsv } from './helpers-enrich'
import { companiesCsv, waitAdded } from './helpers-list'
import { mockTreg } from './helpers-treg'
import { call, mcpClient, waitMcpRun } from './helpers-mcp'

// A list job that also fills the asking row: one call adds the results as rows
// elsewhere (each with a fixed value) and writes the answer's own count into
// this sheet. A rerun whose answer has no results removes the rows that row
// added before, and says "No rows to add".

const COMPANIES: Array<[string, string]> = [['Stripe', 'stripe.com'], ['Notion', 'notion.so'], ['Figma', 'figma.com']]

test('MCP: a list job fills the asking row too, and a rerun with no results removes its rows', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, companiesCsv(COMPANIES))
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e mcp list outputs'))
  const args = {
    sheet_id: sheetId, tool_id: 'treg.people.search', column_name: 'People', inputs: { company_domain: 'Website' },
    outputs: [{ field: 'count', column_name: 'People found' }],
  }
  const list = {
    provider: 'quickenrich', results_per_row: 3, fields: [{ path: '$.first_name', column_name: 'First name' }],
    copy_columns: [{ from: 'Company' }, { to: 'Source', value: 'People search' }],
  }

  const started = await call(client, 'run_enrichment', { ...args, list: { new_sheet_name: 'People', ...list } })
  await waitMcpRun(client, started.run_id, ['completed'])
  await waitAdded(sheetId)
  const source = await rowsOf(api, sheetId)
  expect(source.map(r => [r.People, r['People found']])).toEqual(Array(3).fill(['✅ 3 rows added', '3']))
  const dest = await rowsOf(api, started.destination_sheet_id)
  expect(dest).toHaveLength(9)
  expect(dest.every(r => r.Source === 'People search' && r['First name'])).toBe(true)

  // Stripe's search now answers with an empty list: its three rows go.
  await mockTreg.set({ listSizes: { stripe: 0 } })
  const again = await call(client, 'run_enrichment', {
    ...args, add_to_column: true, fresh: true, rows: 'any',
    list: { destination_sheet_id: started.destination_sheet_id, ...list },
  })
  await waitMcpRun(client, again.run_id, ['completed'])
  await waitAdded(sheetId)
  const after = await rowsOf(api, sheetId)
  expect(after.find(r => r.Company === 'Stripe')).toMatchObject({ People: '✅ No rows to add', 'People found': '0' })
  expect(after.filter(r => r.People === '✅ 3 rows added')).toHaveLength(2)
  const left = await rowsOf(api, started.destination_sheet_id)
  expect(left).toHaveLength(6)
  expect(left.some(r => r.Company === 'Stripe')).toBe(false)
  await mockTreg.set({ listSizes: {} })
  await api.dispose()
})
