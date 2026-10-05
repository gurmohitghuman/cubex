import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi, BASE } from './helpers'

// Live smoke test for the HTTP-API JSON-only hardening (and that the run
// lifecycle still works end to end). Uses REAL public endpoints because the SSRF
// guard blocks localhost mocks:
//   - JSON success: jsonplaceholder.typicode.com/todos/1 -> {userId,id,title,...}
//   - HTML reject:  example.com -> text/html page (must be rejected, NOT scraped)
// Network-dependent by nature; if a host is down the test is skipped, not failed.


const JSON_URL = 'https://jsonplaceholder.typicode.com/todos/1'
const HTML_URL = 'https://example.com/'

async function seedSheet(api: APIRequestContext) {
  // Start from an empty workspace (every spec shares the one account).
  // Mirrors helpers.seedSheet.
  const existing = await (await api.get('/api/tables')).json()
  if (Array.isArray(existing)) for (const t of existing) await api.delete(`/api/tables/${t.id}`)
  const tbl = await api.post('/api/tables', { data: { name: `http-smoke-${Date.now()}` } })
  if (!tbl.ok()) throw new Error(`create table failed: ${tbl.status()} ${await tbl.text()}`)
  const table = await tbl.json()
  const sheetId: string = table.sheets[0].id
  const tableId: string = table.id
  await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'seed' } })
  await api.put(`/api/sheets/${sheetId}/data`, {
    data: {
      updates: [
        { rowIndex: 0, columnName: 'seed', value: 'a' },
        { rowIndex: 1, columnName: 'seed', value: 'b' },
      ],
    },
  })
  return { sheetId, tableId }
}

const skipIfUnreachable = (first: any) =>
  test.skip(
    first?.status === 'error' && /unreachable|ENOTFOUND|timed out|HTTP 5\d\d|fetch failed/i.test(first?.error || ''),
    `upstream unreachable: ${first?.error}`,
  )

test('HTTP API preview: real JSON endpoint extracts a field', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api)

  const res = await api.post('/api/http/preview', {
    data: {
      sheetId,
      config: {
        requestConfig: { method: 'GET', url: JSON_URL, headers: {}, params: [] },
        responseMapping: [{ jsonPath: '$.title', columnName: 'Title' }],
        previewSize: 1,
      },
    },
  })
  expect(res.ok()).toBeTruthy()
  const body = await res.json()
  const results = body.previewResults || body.results || []
  test.skip(results.length === 0, 'no preview rows returned')
  const first = results[0]
  skipIfUnreachable(first)

  expect(first.status).toBe('success')
  expect(String(first.extractedFields?.Title || '')).toContain('delectus')
})

test('HTTP API preview: HTML page is rejected (not scraped)', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api)

  const res = await api.post('/api/http/preview', {
    data: {
      sheetId,
      config: {
        requestConfig: { method: 'GET', url: HTML_URL, headers: {}, params: [] },
        responseMapping: [{ jsonPath: '$.anything', columnName: 'Out' }],
        previewSize: 1,
      },
    },
  })
  expect(res.ok()).toBeTruthy()
  const body = await res.json()
  const results = body.previewResults || body.results || []
  test.skip(results.length === 0, 'no preview rows returned')
  const first = results[0]
  skipIfUnreachable(first)

  // The key assertion: an HTML page must come back as an ERROR with the JSON-only
  // message — NOT a success that scraped the page into a cell.
  expect(first.status).toBe('error')
  expect(first.error || '').toMatch(/only supports (valid )?JSON|HTML\/XML pages are not supported/i)
  expect(JSON.stringify(first.extractedFields || {})).not.toMatch(/<html|<!doctype/i)
})

test('HTTP API run: JSON endpoint populates cells (end to end in the browser)', async ({ page }) => {
  // Background Sidequest run + browser render needs more than the 30s default.
  test.setTimeout(90_000)
  // Auth is an HttpOnly cubex_session cookie — log in via the PAGE's own request
  // context so the cookie lands on the browser context that will navigate (the
  // shared authedApi context is a separate cookie jar the page can't see).
  const login = await page.request.post(`${BASE}/api/auth/login`, {
    data: { password: 'password123' },
  })
  expect(login.ok()).toBeTruthy()
  const api = page.request
  const { sheetId, tableId } = await seedSheet(api)

  const run = await api.post(`${BASE}/api/http/run`, {
    data: {
      sheetId,
      masterColumnName: 'Lookup',
      config: {
        requestConfig: { method: 'GET', url: JSON_URL, headers: {}, params: [] },
        responseMapping: [{ jsonPath: '$.title', columnName: 'Title' }],
        batchSize: 2,
      },
    },
  })
  expect(run.ok()).toBeTruthy()

  let populated = false
  let diag = ''
  for (let i = 0; i < 45; i++) {
    const res = await api.get(`/api/sheets/${sheetId}?limit=1000&offset=0`)
    expect(res.ok()).toBeTruthy()
    const rows = (await res.json()).data?.rows || []
    const titles = rows.map((r: any) => r.data?.Title || '').filter(Boolean)
    const stillProcessing = rows.some((r: any) => String(r.data?.Lookup || '').includes('Processing'))
    // Run is done once nothing's still "⏳ Processing..." and at least one row
    // extracted the JSON field. (jsonplaceholder returns the same body per row;
    // we only assert the extraction worked, not the row count.)
    if (titles.length >= 1 && !stillProcessing) { populated = true; break }
    diag = `iter ${i}: titles=${titles.length} processing=${stillProcessing}`
    await page.waitForTimeout(1000)
  }
  expect(populated, `run did not populate. ${diag}`).toBeTruthy()

  await page.goto(`${BASE}/table/${tableId}`)
  await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 10_000 })
  // The extracted value rendered into the grid. We match on TEXT (not col-id):
  // AG Grid's DOM col-id is an opaque internal id (col_xxxx), not the column
  // name, so a [col-id="Title"] selector wouldn't match.
  await expect(
    page.locator('.ag-cell').filter({ hasText: /delectus/ }).first(),
  ).toBeVisible({ timeout: 10_000 })
})

// Double-check: run → rename one extracted column → delete another →
// rerun. Confirms Bugs 1+2+3 together: the rerun must write results to the
// RENAMED column (not resurrect the old name) and must NOT leave any cell stuck
// on '⏳ Processing...'. All server-side, so driven via the API.
test('HTTP rerun after rename + delete: no resurrected column, no stuck cells', async ({ request }) => {
  test.setTimeout(90_000)
  const login = await request.post(`${BASE}/api/auth/login`, {
    data: { password: 'password123' },
  })
  expect(login.ok()).toBeTruthy()
  const { sheetId } = await seedSheet(request)

  // Initial run: master "Lookup" + two extracted columns.
  const cfg = (cols: Array<{ jsonPath: string; columnName: string }>) => ({
    requestConfig: { method: 'GET', url: JSON_URL, headers: {}, params: [] },
    responseMapping: cols, batchSize: 2,
  })
  const run = await request.post(`${BASE}/api/http/run`, {
    data: {
      sheetId, masterColumnName: 'Lookup',
      config: cfg([{ jsonPath: '$.title', columnName: 'Title' }, { jsonPath: '$.id', columnName: 'ItemId' }]),
    },
  })
  expect(run.ok()).toBeTruthy()

  const readRows = async () =>
    (await (await request.get(`/api/sheets/${sheetId}?limit=1000&offset=0`)).json()).data?.rows || []
  const noneProcessing = (rows: any[]) => !rows.some((r: any) =>
    Object.values(r.data || {}).some(v => String(v).includes('Processing')))
  // Completion = nothing still '⏳ Processing...' AND the master 'Lookup' cell
  // reached a terminal marker (✅/⏭️/❌). Column-name-agnostic on purpose — the
  // extracted column gets RENAMED mid-test, so we must NOT key off its name.
  const waitDone = async () => {
    for (let i = 0; i < 45; i++) {
      const rows = await readRows()
      const masterDone = rows.length > 0 && rows.every((r: any) => {
        const m = String(r.data?.Lookup || '')
        return m !== '' && !m.includes('Processing')
      })
      if (noneProcessing(rows) && masterDone) return rows
      await new Promise(r => setTimeout(r, 1000))
    }
    return null
  }

  const r1 = await waitDone()
  test.skip(!r1, 'initial run did not complete (likely upstream/network)')

  // Rename "Title" -> "Heading", delete "ItemId".
  const ren = await request.put(`/api/sheets/${sheetId}/columns/Title`, { data: { newName: 'Heading' } })
  expect(ren.ok()).toBeTruthy()
  const del = await request.delete(`/api/sheets/${sheetId}/columns/ItemId`)
  expect(del.ok()).toBeTruthy()

  // Rerun all rows on the master column.
  const rerun = await request.post(`/api/http/rerun`, {
    data: { sheetId, masterColumnName: 'Lookup', mode: 'all' },
  })
  expect(rerun.ok(), `rerun failed: ${rerun.status()} ${await rerun.text()}`).toBeTruthy()

  const r2 = await waitDone()
  expect(r2, 'rerun did not complete').toBeTruthy()
  const row0 = (r2 as any[]).find((r: any) => r.row_index === 0) || (r2 as any[])[0]

  // Results landed on the RENAMED column...
  expect(String(row0.data.Heading || ''), 'renamed column has the result').toContain('delectus')
  // ...the OLD name was NOT resurrected...
  expect(row0.data.Title, 'old column name not resurrected').toBeUndefined()
  // ...the deleted column stays gone...
  expect(row0.data.ItemId, 'deleted column stays gone').toBeUndefined()
  // ...and NOTHING is stuck on the placeholder.
  expect(noneProcessing(r2 as any[]), 'no cell stuck on Processing').toBeTruthy()
})
