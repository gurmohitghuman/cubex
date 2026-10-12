import { test, expect } from '@playwright/test'
import { authedApi, makeAccessToken, BASE } from './helpers'
import { freshTreg, rowsOf, seedCsv } from './helpers-enrich'
import { call, callError, mcpClient } from './helpers-mcp'
import { JSON_URL } from './api-v1-run-helpers'

// "Only run if" rules (server lib/run-condition.ts) through MCP, the way an
// agent chains columns: check a rule (free), estimate counts only passing rows,
// AI / HTTP / enrichment runs mark the rows a rule keeps out "⏭️ Condition not
// met" (no call, no cost), reruns repeat the rule, a column rename rewrites it,
// and the drawers' rule box says how many rows will run.

const CSV = [
  'Name,Website,Tier',
  'Maya Chen,https://stripe.com,A',
  'Leo Martins,notion.so,B',
  'Ava Patel,figma.com,A',
  'Sam Lee,linear.app,',
].join('\n')
const NOT_MET = '⏭️ Condition not met'
const DONE = ['completed', 'failed', 'cancelled']

async function waitRun(client: Awaited<ReturnType<typeof mcpClient>>, type: string, runId: string) {
  const until = Date.now() + 60_000
  for (;;) {
    const s = await call(client, 'get_run_status', { run_type: type, run_id: runId, wait_seconds: 2 })
    if (DONE.includes(s.status)) return s
    if (Date.now() > until) throw new Error(`run ${runId} is still ${s.status}`)
  }
}

test.describe.configure({ mode: 'serial' })

test('MCP: check, estimate, and AI / HTTP / enrichment runs that skip rows by rule', async () => {
  test.setTimeout(150_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedCsv(api, CSV)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e run-if'))

  // Checking a rule is free, counts the whole sheet and names a misspelled column.
  const checked = await call(client, 'check_run_condition', { sheet_id: sheetId, rule: '{{tier}} = "a"' })
  expect(checked.rule).toBe('{{Tier}} is "a"')
  expect([checked.rows_passing, checked.rows_skipped]).toEqual([2, 2])
  expect(checked.sample.map((r: any) => r.passes)).toEqual([true, false, true, false])
  expect(await callError(client, 'check_run_condition', { sheet_id: sheetId, rule: '{{Teir}} is "A"' }))
    .toMatch(/no column named "Teir"\. Did you mean "Tier"\?/)
  // Writing one needs a model and a key; the test account has no OpenRouter key.
  expect(await callError(client, 'write_run_condition', { sheet_id: sheetId, text: 'tier A only' }))
    .toMatch(/model|OpenRouter/)

  // estimate_only counts only the rows that pass; a bad rule is refused.
  const est = await call(client, 'run_ai_column', {
    sheet_id: sheetId, column_name: 'Fit', prompt: 'Is /name a fit?', run_if: '{{Tier}} is "A"', estimate_only: true,
  })
  expect(est.rows_to_process).toBe(2)
  expect(est.rows_skipped_by_rule).toBe(2)
  expect(await callError(client, 'run_ai_column', {
    sheet_id: sheetId, column_name: 'Fit', prompt: 'x /name', run_if: '{{Tier}} is A', model: 'openai/gpt-4o-mini',
  })).toMatch(/Only run if.*quotes/)

  // AI: the two B / empty rows never reach the model.
  const ai = await call(client, 'run_ai_column', {
    sheet_id: sheetId, column_name: 'Fit', prompt: 'Is /name a fit?', model: 'openai/gpt-4o-mini',
    run_if: '{{Tier}} is "A"',
  })
  expect(ai.run_if).toBe('{{Tier}} is "A"')
  const aiDone = await waitRun(client, 'ai', ai.run_id)
  expect(aiDone.condition_skipped_rows).toBe(2)
  expect(aiDone.total_rows).toBe(2)
  let rows = await rowsOf(api, sheetId)
  expect(rows.map(r => r['Fit (Output)'] === NOT_MET)).toEqual([false, true, false, true])

  // HTTP: no request for rows the rule keeps out.
  const http = await call(client, 'run_http_enrichment', {
    sheet_id: sheetId, url: JSON_URL, master_column_name: 'Lookup',
    response_mapping: [{ json_path: '$.title', column_name: 'Title' }], run_if: '{{Tier}} is not empty',
  })
  const httpDone = await waitRun(client, 'http', http.run_id)
  expect(httpDone.condition_skipped_rows).toBe(1)
  rows = await rowsOf(api, sheetId)
  expect(rows[3].Lookup).toBe(NOT_MET)
  expect(rows[3].Title ?? '').toBe('')
  expect(rows[0].Lookup).toContain('✅')

  // Enrichment chained on a rule: B and the empty tier stay out, with no treg call.
  const enr = await call(client, 'run_enrichment', {
    sheet_id: sheetId, tool_id: 'treg.people.email.find', preset: 'verified_email', column_name: 'Work email',
    inputs: { full_name: 'Name', domain: 'Website' }, run_if: '{{Tier}} is "A" AND {{Lookup}} is not empty',
  })
  expect(enr.rows_in_scope).toBe(2)
  const enrDone = await waitRun(client, 'enrichment', enr.run_id)
  expect(enrDone.status).toBe('completed')
  expect(enrDone.condition_skipped_rows).toBe(2)
  rows = await rowsOf(api, sheetId)
  expect(rows.map(r => r['Work email'] === NOT_MET)).toEqual([false, true, false, true])

  // A rule reading a column whose rows a rule kept out: those read as empty.
  expect((await call(client, 'check_run_condition', {
    sheet_id: sheetId, rule: '{{Lookup}} is not empty',
  })).sample.map((r: any) => r.passes)).toEqual([true, true, true, false])

  // Renaming a column rewrites the rules that name it, so a rerun still runs.
  await call(client, 'rename_column', { sheet_id: sheetId, column: 'Tier', new_name: 'Plan' })
  const after = await call(client, 'get_run_status', { run_type: 'http', run_id: http.run_id })
  expect(after.run_if).toBe('{{Plan}} is not empty')
  // Row 4 gets a plan: "missing" reruns take rows a rule kept out, and the rule decides again.
  const four = (await call(client, 'read_rows', { sheet_id: sheetId })).rows[3].id
  await call(client, 'update_cells', { row_id: four, data: { Plan: 'C' } })
  const again = await call(client, 'control_run', {
    run_type: 'http', run_id: http.run_id, action: 'rerun', mode: 'missing',
  })
  await waitRun(client, 'http', again.run_id)
  rows = await rowsOf(api, sheetId)
  expect(rows[3].Lookup).toContain('✅')

  await client.close()
})

test('the AI drawer\'s rule box counts the rows that will run', async ({ page, context }) => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { tableId } = await seedCsv(api, CSV)
  await context.addCookies((await api.storageState()).cookies)
  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'AI Column', exact: true }).click()
  await page.getByRole('button', { name: /Only run if/ }).click()
  await page.getByRole('button', { name: 'Add a rule' }).click()
  const rule = page.getByLabel('Rule', { exact: true })
  await rule.fill('{{Tier}} is "A" OR {{Name}} contains "sam"')
  await expect(page.getByTestId('run-if-check')).toContainText('3 of 4 rows will run')
  await rule.fill('{{Tierr}} is "A"')
  await expect(page.getByTestId('run-if-error')).toContainText('Did you mean "Tier"?')
})
