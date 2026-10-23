import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, makeAccessToken, BASE } from './helpers'
import { freshTreg, rowsOf, waitRun } from './helpers-enrich'
import { waitAdded } from './helpers-list'
import { call, mcpClient } from './helpers-mcp'

// An AI visibility table (services/ai-visibility-*.ts) against the mock's AI
// engines (tests/mock-treg/ai-search.mjs): made without asking anything, asked
// after an estimate, the formulas reading the answers (your place, how many
// engines name you, who's named first), the cited sites with their domain and
// whether they're yours, then other brands looked for. Over the app's API,
// then the MCP tool's estimate default.

const INPUT = {
  brand: 'Acme CRM', competitors: ['Northdesk', 'Pipewell', 'Clientry'], domain: 'https://acme-crm.com',
  questions: ['Best CRM for a small team?', 'Cheapest CRM for two people?'],
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`${what}: ${JSON.stringify(v).slice(0, 400)}`)
    await new Promise(r => setTimeout(r, 300))
  }
}

async function make(api: APIRequestContext) {
  const res = await api.post('/api/ai-visibility', { data: INPUT })
  expect(res.ok(), await res.text()).toBeTruthy()
  return res.json()
}

test('make, estimate, ask: the answers, where you stand, the sites they cite', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  const made = await make(api)
  expect(made.problems).toEqual([])
  expect(made.sheets.map((s: { name: string }) => s.name)).toEqual(['Questions', 'Cited sites'])
  const v = made.aiVisibility
  expect(v).toMatchObject({ brand: 'Acme CRM', domain: 'acme-crm.com', country: 'US',
    engines: ['chatgpt', 'gemini', 'ai_mode', 'perplexity'] })

  const sheet = await (await api.get(`/api/sheets/${v.questionsSheetId}`)).json()
  expect(sheet.data.columns.slice(0, 6)).toEqual(['Question', 'Named by', 'Named first', 'ChatGPT', 'ChatGPT answer',
    'You in ChatGPT'])
  expect(sheet.data.columnTypes.ChatGPT).toBe('enrich-status')
  expect(sheet.data.aiVisibility.id).toBe(v.id)
  // Nothing was asked: no call reached treg.
  expect((await rowsOf(api, v.questionsSheetId)).every(r => !r.ChatGPT && !r['Named by'])).toBe(true)

  const est = (await (await api.post(`/api/ai-visibility/${v.id}/ask`, { data: { estimateOnly: true } })).json())
    .estimate
  expect(est.engines.map((e: { column: string }) => e.column)).toEqual(['ChatGPT', 'Gemini', 'AI Mode', 'Perplexity'])
  expect(est.rows).toBe(2)
  // About $0.015 a question for the four (each tool's own catalog price, per call).
  expect(est.highUsd).toBeGreaterThan(0.02)
  expect(est.highUsd).toBeLessThan(0.05)
  expect(est.problems).toEqual([])

  const asked = await (await api.post(`/api/ai-visibility/${v.id}/ask`, { data: {} })).json()
  expect(asked.problems).toEqual([])
  expect(asked.started).toHaveLength(4)
  for (const s of asked.started) await waitRun(api, s.runId, ['completed'])
  await waitAdded(v.questionsSheetId)

  // Each formula column fills on its own as the answers come: wait for all of them.
  const formulas = ['Named by', 'Named first',
    ...['ChatGPT', 'Gemini', 'AI Mode', 'Perplexity'].map(e => `You in ${e}`)]
  const rows = await until(() => rowsOf(api, v.questionsSheetId), r => r.every(x => formulas.every(c => x[c])),
    'formulas')
  const first = rows.find(r => r.Question === INPUT.questions[0])!
  expect(first['ChatGPT answer']).toContain('Northdesk is the usual pick')
  expect([first['You in ChatGPT'], first['You in Gemini'], first['You in AI Mode'], first['You in Perplexity']])
    .toEqual(['2nd of 2', 'Not named', '1st of 3', 'Not named'])
  expect(first['Named by']).toBe('2 of 4')
  expect(first['Named first']).toBe('Northdesk')
  expect(first.ChatGPT).toBe('✅ 2 rows added')
  expect(first.AI).toBeUndefined()

  const sites = await until(() => rowsOf(api, v.sitesSheetId), r => r.length === 12 && r.every(x => x.Domain),
    'cited sites')
  expect(new Set(sites.map(s => s.Engine))).toEqual(new Set(['ChatGPT', 'Gemini', 'AI Mode', 'Perplexity']))
  const mine = sites.filter(s => s['Your site'] === 'Yes')
  expect(mine.map(s => s.Domain)).toEqual(Array(4).fill('acme-crm.com'))
  expect(sites.find(s => s.Engine === 'Perplexity')).toMatchObject({ Title: 'Thread 1', Domain: 'reddit.com' })

  // Northdesk no longer looked for: ChatGPT now names only you.
  const brands = await api.put(`/api/ai-visibility/${v.id}/brands`,
    { data: { brand: 'Acme CRM', competitors: ['Pipewell', 'Clientry'] } })
  expect(brands.ok(), await brands.text()).toBeTruthy()
  expect((await brands.json()).columns).toContain('You in ChatGPT')
  await until(() => rowsOf(api, v.questionsSheetId),
    r => r.find(x => x.Question === INPUT.questions[0])?.['You in ChatGPT'] === '1st of 1', 'new brands')
  await api.dispose()
})

test('MCP: ai_visibility asks for the estimate unless told otherwise', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await freshTreg(api)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e ai visibility'))
  const made = await call(client, 'ai_visibility', {
    action: 'create', brand: 'Acme CRM', other_brands: ['Northdesk'], questions: ['Best CRM?'], engines: ['chatgpt'],
  })
  expect(made).toMatchObject({ brand: 'Acme CRM', other_brands: ['Northdesk'], engines: ['chatgpt'], problems: [] })
  // get_sheet says the engine column is set up and has never run.
  const sheet = await call(client, 'get_sheet', { sheet_id: made.questions_sheet_id, column_details: true })
  expect(sheet.column_details.find((d: { name: string }) => d.name === 'ChatGPT').fill.run_status).toBe('set_up')
  // By the Questions sheet's id too (what list_tables shows).
  const est = await call(client, 'ai_visibility', { action: 'ask', id: made.questions_sheet_id })
  expect(est).toMatchObject({ estimate_only: true, questions: 1 })
  expect((await rowsOf(api, made.questions_sheet_id))[0].ChatGPT ?? '').toBe('')
  const asked = await call(client, 'ai_visibility', { action: 'ask', id: made.id, estimate_only: false })
  expect(asked.runs).toHaveLength(1)
  await waitRun(api, asked.runs[0].run_id, ['completed'])
  await until(() => rowsOf(api, made.questions_sheet_id), r => r[0]['You in ChatGPT'] === '2nd of 2', 'answer')

  // The same over /api/v1: asking needs the run scope; a write-only token makes and edits.
  const writer = { Authorization: `Bearer ${await makeAccessToken(api, ['read', 'write'], 'e2e aiv writer')}` }
  const rest = await api.post('/api/v1/ai-visibility', { headers: writer,
    data: { brand: 'Acme CRM', questions: ['Best CRM?'], engines: ['gemini'] } })
  expect(rest.status()).toBe(201)
  const id = (await rest.json()).id
  expect((await api.post(`/api/v1/ai-visibility/${id}/ask`, { headers: writer, data: {} })).status()).toBe(403)
  const edited = await api.put(`/api/v1/ai-visibility/${id}/brands`, { headers: writer,
    data: { brand: 'Acme CRM', other_brands: ['Pipewell'] } })
  expect(await edited.json()).toMatchObject({ other_brands: ['Pipewell'], formulas_rewritten: ['You in Gemini',
    'Named by', 'Named first'] })
  // Only the brand given: the other brands stay.
  const renamed = await api.put(`/api/v1/ai-visibility/${id}/brands`, { headers: writer, data: { brand: 'Acme' } })
  expect(await renamed.json()).toMatchObject({ brand: 'Acme', other_brands: ['Pipewell'] })

  // A brand a table name can't hold, and Perplexity alone (its sources have no Position): made, in order.
  const odd = await (await api.post('/api/v1/ai-visibility', { headers: writer,
    data: { brand: 'Acme "Pro" <x>', questions: ['Best CRM?'], engines: ['perplexity'] } })).json()
  expect(odd).toMatchObject({ table_name: 'AI visibility for Acme Pro x', problems: [] })
  const again = await (await api.post('/api/v1/ai-visibility', { headers: writer,
    data: { brand: 'Acme "Pro" <x>', questions: ['Best CRM?'], engines: ['perplexity'] } })).json()
  expect(again.table_name).toBe('AI visibility for Acme Pro x 2')
  const sites = await (await api.get(`/api/sheets/${odd.sites_sheet_id}`)).json()
  expect(sites.data.columns).toEqual(['Question', 'Engine', 'Title', 'URL', 'Domain'])
  await api.dispose()
})

test('the app: make the table from the dashboard, ask from its guide', async ({ page, context }) => {
  test.setTimeout(120_000)
  const api = await authedApi()
  await freshTreg(api)
  for (const t of await (await api.get('/api/tables')).json()) await api.delete(`/api/tables/${t.id}`)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/`)
  await page.getByTestId('ai-visibility-open').click()
  const dialog = page.getByTestId('ai-visibility-dialog')
  await dialog.getByLabel('Your brand').fill('Acme CRM')
  await dialog.getByLabel('Other brands to look for').fill('Northdesk, Pipewell')
  await dialog.getByLabel('Your site').fill('acme-crm.com')
  await dialog.getByLabel('Questions').fill('Best CRM for a small team?\nCheapest CRM for two people?')
  await expect(dialog).toContainText('2 questions, 4 engines')
  await dialog.getByTestId('ai-visibility-create').click()

  const guide = page.getByTestId('ai-visibility-guide')
  await expect(guide).toContainText('Do AI engines name Acme CRM?', { timeout: 30_000 })
  await expect(guide.getByTestId('ai-visibility-brands')).toContainText('Northdesk, Pipewell')
  await expect(page.locator('.ag-row[row-index="1"]').first()).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: process.env.AIV_SHOTS ? `${process.env.AIV_SHOTS}/guide.png` : undefined })

  await guide.getByTestId('ai-visibility-ask').click()
  const confirm = page.getByTestId('ai-visibility-ask-confirm')
  await expect(confirm).toContainText('2 questions not asked yet, 4 engines: ChatGPT, Gemini, AI Mode, Perplexity')
  await expect(confirm.getByTestId('ai-visibility-cost')).toContainText('from your treg balance')
  await page.screenshot({ path: process.env.AIV_SHOTS ? `${process.env.AIV_SHOTS}/confirm.png` : undefined })
  await confirm.getByTestId('ai-visibility-ask-go').click()
  await expect(confirm).toBeHidden()

  const sheetId = new URL(page.url()).pathname.split('/').pop()!
  await until(() => rowsOf(api, sheetId), r => r.length === 2 && r.every(x => x['Named by'] === '2 of 4'), 'answers')
  await expect(page.locator('.ag-cell').filter({ hasText: '2 of 4' }).first()).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: process.env.AIV_SHOTS ? `${process.env.AIV_SHOTS}/answers.png` : undefined })
  await api.dispose()
})
