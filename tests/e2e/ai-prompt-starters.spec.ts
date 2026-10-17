import { test, expect, type Page } from '@playwright/test'
import { authedApi, BASE, getSheet } from './helpers'
import { seedCsv } from './helpers-enrich'

// The AI column dialog's prompt starters: picking one writes a prompt with the
// sheet's own columns and names the column; another replaces what the first
// filled in; typing your own prompt hides them. The company profile starter
// sets up output columns: its preview offers no "Add Column" (only a run fills
// them) and leaves no old draft behind, and Run All Rows makes each output
// column and the "(Status)" column.
// Rows fail for free on a fake OpenRouter key.

const CSV = 'First name,Company name,Company website\nAda,Stripe,stripe.com\nAlan,Figma,figma.com'
const shots = process.env.E2E_SHOTS
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }) }

test('prompt starters fill the prompt from the sheet; the profile one runs into output columns', async ({
  page, context,
}) => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedCsv(api, CSV)
  expect((await api.put(`/api/sheets/${sheetId}/default-model`, { data: { model: 'deepseek/deepseek-v4-flash' } }))
    .ok()).toBeTruthy()
  expect((await api.put('/api/settings/openrouter-key', { data: { apiKey: 'sk-or-v1-invalid-e2e' } })).ok())
    .toBeTruthy()
  try {
    await context.addCookies((await api.storageState()).cookies)
    await page.goto(`${BASE}/table/${tableId}`)
    await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: 'AI Column', exact: true }).click()
    // A single-column draft from an earlier preview (another tab): the structured preview replaces it.
    const draftOf = async () => (await (await api.get(`/api/ai/drafts/${sheetId}`)).json()).draft
    await api.post('/api/ai/preview', { data: { sheetId, columnName: 'Old idea', prompt: 'Hi /first_name' } })
    expect((await draftOf())?.config?.columnName).toBe('Old idea')

    const starters = page.getByTestId('prompt-starters')
    const prompt = page.locator('#prompt')
    const name = page.getByPlaceholder('e.g., Industry Analysis, Sentiment Score')
    await expect(starters.getByRole('button')).toHaveText(['Qualify (YES/NO)', 'Classify', 'Write an opener',
      'Lead score 1-10', 'Company profile'])
    await starters.getByRole('button', { name: 'Qualify (YES/NO)' }).click()
    await expect(prompt).toHaveValue(/Company name: \/company_name\nCompany website: \/company_website/)
    await expect(prompt).toHaveValue(/Answer with only YES or NO\.$/)
    await expect(name).toHaveValue('Qualified')
    await expect(page.getByTestId('output-columns')).toHaveCount(0)
    await shot(page, 'starters-qualify')

    await starters.getByRole('button', { name: 'Write an opener' }).click()
    await expect(prompt).toHaveValue(/^Write the first line of a cold email to \/first_name\./)
    await expect(name).toHaveValue('Opener')

    // The profile starter: output columns, and the main name makes "(Status)".
    await starters.getByRole('button', { name: 'Company profile' }).click()
    await expect(name).toHaveValue('Company profile')
    const outputs = page.getByTestId('output-columns')
    await expect(outputs).toContainText('"Company profile (Status)" shows how each row went')
    await expect(page.getByLabel('Output column 1 name')).toHaveValue('Industry')
    await expect(page.getByLabel('Output column 2 type')).toHaveValue('number')
    await expect(page.getByLabel(/^Output column \d name$/)).toHaveCount(6)
    await shot(page, 'starters-profile')

    // "Use one column instead" takes them away; the starter brings them back.
    await page.getByRole('button', { name: 'Use one column instead' }).click()
    await expect(outputs).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Fill several columns from one answer' })).toBeVisible()
    await starters.getByRole('button', { name: 'Company profile' }).click()
    await expect(page.getByLabel(/^Output column \d name$/)).toHaveCount(6)

    // A name the sheet has is caught before a preview.
    await page.getByLabel('Output column 1 name').fill('Company name')
    await expect(outputs).toContainText('This sheet already has a column "Company name"')
    await expect(page.getByRole('button', { name: /Try on/ })).toBeDisabled()
    await page.getByLabel('Output column 1 name').fill('Industry')
    await page.getByRole('button', { name: 'Remove output column 6' }).click()
    await expect(page.getByLabel(/^Output column \d name$/)).toHaveCount(5)

    // Typing your own words hides the starters (they never replace them).
    await prompt.fill(`${await prompt.inputValue()} Keep it short.`)
    await expect(starters).toHaveCount(0)

    await page.getByRole('button', { name: /Try on/ }).click()
    await expect(page.getByText('Run all rows to fill the output columns.')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'Run All Rows' })).toBeEnabled({ timeout: 60_000 })
    await expect(page.getByRole('button', { name: 'Add Column' })).toHaveCount(0)
    expect(await draftOf()).toBeNull()
    await shot(page, 'starters-profile-preview')
    await page.getByRole('button', { name: 'Run All Rows' }).click()

    await expect.poll(async () => (await getSheet(api, sheetId)).data.columns, { timeout: 20_000 })
      .toEqual(expect.arrayContaining(['Industry', 'Employees', 'Headquarters', 'Founded', 'B2B',
        'Company profile (Status)']))
    const runs = await (await api.get('/api/ai/runs', { params: { sheetId } })).json()
    const run = runs.find((r: any) => r.column_name === 'Company profile (Status)')
    expect(JSON.parse(run.output_columns).map((o: any) => o.columnName))
      .toEqual(['Industry', 'Employees', 'Headquarters', 'Founded', 'B2B'])
    expect(run.prompt).toContain('Company website: /company_website')
  } finally {
    await api.delete('/api/settings/openrouter-key')
  }
  await api.dispose()
})
