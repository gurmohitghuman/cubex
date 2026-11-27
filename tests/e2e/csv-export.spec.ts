import { readFile } from 'node:fs/promises'
import { test, expect, request as pwRequest } from '@playwright/test'
import { authedApi, BASE, seedSheet, setSheetName } from './helpers'
import { seedCsv } from './helpers-enrich'
import { bearer, makeToken } from './api-v1-run-helpers'
import { call, mcpClient } from './helpers-mcp'
import { openDataMenu } from './helpers-ui'

// E2E coverage for sheets-csv-export.ts — the Content-Disposition filename
// injection fix (contentDispositionFilename in lib/csv-safety.ts) and the
// export content path (unchanged by the split out of the old sheets-csv.ts).

// ---------------------------------------------------------------------------
// Content-Disposition filename injection (the security fix)
// ---------------------------------------------------------------------------
test.describe('CSV export: Content-Disposition filename safety', () => {
  test('a CRLF/header-injection sheet name cannot break the header', async () => {
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 2)
    setSheetName(sheetId, 'evil"\r\nSet-Cookie: pwned=1')

    const res = await api.get(`/api/sheets/${sheetId}/export`)
    expect(res.ok()).toBeTruthy()
    const cd = res.headers()['content-disposition']
    expect(cd).toBeTruthy()

    // No raw CR/LF survives anywhere in the header value (header splitting).
    expect(cd).not.toMatch(/[\r\n]/)
    // The injected header name must not appear as a real, separate header.
    expect(res.headers()['set-cookie']).toBeUndefined()
    // The ASCII filename="..." fallback must not contain a bare " that escapes
    // the quoted-string (the injected " and control chars become _).
    const asciiMatch = cd.match(/filename="([^"]*)"/)
    expect(asciiMatch).toBeTruthy()
    expect(asciiMatch![1]).not.toContain('"')
    expect(asciiMatch![1]).toContain('_') // sanitized chars became underscores
    // The full original survives, percent-encoded, in the RFC 5987 form.
    expect(cd).toContain("filename*=UTF-8''")
    expect(cd).toContain('%0D%0A') // CR LF encoded, not literal

    await api.dispose()
  })

  test('a quote-escape sheet name is neutralized in the ASCII fallback', async () => {
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 1)
    setSheetName(sheetId, 'name"; filename="x')

    const res = await api.get(`/api/sheets/${sheetId}/export`)
    const cd = res.headers()['content-disposition']
    // Exactly ONE filename="..." token — the attacker's second one was quoted away.
    const asciiTokens = cd.match(/filename="/g) || []
    expect(asciiTokens.length).toBe(1)
    expect(cd).not.toMatch(/[\r\n]/)
    await api.dispose()
  })

  test('a Unicode sheet name survives via filename* with a safe ASCII fallback', async () => {
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 1)
    setSheetName(sheetId, 'Ünïcödé 日本語')

    const res = await api.get(`/api/sheets/${sheetId}/export`)
    const cd = res.headers()['content-disposition']
    // RFC 5987 carries the real Unicode (percent-encoded UTF-8).
    expect(cd).toContain("filename*=UTF-8''")
    expect(cd).toContain(encodeURIComponent('日本語'))
    // ASCII fallback is pure ASCII (non-ASCII replaced with _), no control chars.
    const ascii = cd.match(/filename="([^"]*)"/)![1]
    expect(ascii).toMatch(/^[\x20-\x7e]*$/)
    expect(ascii.endsWith('.csv')).toBeTruthy()
    await api.dispose()
  })

  test('a normal sheet name passes through unchanged', async () => {
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 1)
    setSheetName(sheetId, 'My Report')

    const res = await api.get(`/api/sheets/${sheetId}/export`)
    const cd = res.headers()['content-disposition']
    expect(cd).toContain('filename="My Report.csv"')
    await api.dispose()
  })
})

// ---------------------------------------------------------------------------
// Content correctness (the split must not have changed behavior)
// ---------------------------------------------------------------------------
test.describe('CSV export: content', () => {
  test('round-trips header + rows with RFC-4180 quoting and formula-trigger escaping', async () => {
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 0) // 'val' column, placeholder row 0
    // Add a 2nd column and a 2nd row, then fill them: a plain value, a value
    // needing quote-escaping (embedded comma + quote), and a formula-trigger
    // cell. The column-add already created row 0; create row 1 via POST /rows
    // BEFORE the value PUT (upsert writes existing rows, it doesn't create them).
    await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'note' } })
    await api.post(`/api/sheets/${sheetId}/rows`, { data: { count: 1 } })
    await api.put(`/api/sheets/${sheetId}/data`, {
      data: {
        updates: [
          { rowIndex: 0, columnName: 'val', value: 'hello' },
          { rowIndex: 0, columnName: 'note', value: 'a,b "c"' },
          { rowIndex: 1, columnName: 'val', value: '=SUM(A1)' },
          { rowIndex: 1, columnName: 'note', value: 'plain' },
        ],
      },
    })

    const res = await api.get(`/api/sheets/${sheetId}/export`)
    expect(res.ok()).toBeTruthy()
    expect(res.headers()['content-type']).toContain('text/csv')
    const body = await res.text()
    const lines = body.split('\r\n')

    // Header row: every field is quote-wrapped.
    expect(lines[0]).toBe('"val","note"')
    // Row 0: embedded comma + doubled quotes.
    expect(lines[1]).toBe('"hello","a,b ""c"""')
    // Row 1: formula trigger gets a leading single quote inside the quotes.
    expect(lines[2]).toBe(`"'=SUM(A1)","plain"`)
    await api.dispose()
  })

  test('exporting a sheet with no rows is a clean 400', async () => {
    const api = await authedApi()
    // A brand-new table's default Sheet1 has NO columns and NO rows. (seedSheet
    // can't produce a row-less sheet: adding its 'val' column seeds a
    // placeholder row at index 0 — sheets-columns-mutate.ts.) Clear tables first,
    // mirroring seedSheet.
    const existing = await (await api.get('/api/tables')).json()
    if (Array.isArray(existing)) for (const t of existing) await api.delete(`/api/tables/${t.id}`)
    const tbl = await (await api.post('/api/tables', { data: { name: `Empty_${Date.now()}` } })).json()
    const sheetId = tbl.sheets[0].id

    const res = await api.get(`/api/sheets/${sheetId}/export`)
    expect(res.status()).toBe(400)
    expect((await res.json()).error).toMatch(/no data/i)
    await api.dispose()
  })
})

// A CSV for another tool (a CRM, a sending tool): every cell exactly as it is, on every surface that writes CSV;
// without it the formula guard stays. The app's menu entry downloads it, named "(for import)".
test.describe('CSV export for another tool: cells as they are', () => {
  const CSV = ['Name,Phone,Handle,Note', 'Ada,+1 (415) 555-0199,@ada,- Hiring 3 SDRs'].join('\n')
  const RAW_ROW = '"Ada","+1 (415) 555-0199","@ada","- Hiring 3 SDRs"'
  const GUARDED_ROW = `"Ada","'+1 (415) 555-0199","'@ada","'- Hiring 3 SDRs"`

  test('the app route, REST, read_rows and file_link take raw; without it cells are guarded', async () => {
    const api = await authedApi()
    const { sheetId } = await seedCsv(api, CSV)
    const app = async (q: string) => (await api.get(`/api/sheets/${sheetId}/export${q}`)).text()
    expect(await app('?raw=1')).toContain(RAW_ROW)
    expect(await app('')).toContain(GUARDED_ROW)

    const token = await makeToken(api, ['read'], 'csv for tools')
    const v1 = await bearer(token)
    expect(await (await v1.get(`/api/v1/sheets/${sheetId}/export?raw=true`)).text()).toContain(RAW_ROW)
    expect(await (await v1.get(`/api/v1/sheets/${sheetId}/export`)).text()).toContain(GUARDED_ROW)
    expect((await v1.get(`/api/v1/sheets/${sheetId}/export?raw=true&format=jsonl`)).status()).toBe(400)
    await v1.dispose()

    const mcp = await mcpClient(token)
    expect((await call(mcp, 'read_rows', { sheet_id: sheetId, format: 'csv', raw: true })).csv).toContain(RAW_ROW)
    expect((await call(mcp, 'read_rows', { sheet_id: sheetId, format: 'csv' })).csv).toContain(GUARDED_ROW)
    const link = await call(mcp, 'file_link', { action: 'download', sheet_id: sheetId, raw: true })
    const file = await (await pwRequest.newContext()).get(link.download_url)
    expect(await file.text()).toContain(RAW_ROW)
    await mcp.close()
  })

  test('the data menu\'s "Export for a CRM or email tool" downloads cells as they are', async ({ page, context }) => {
    const api = await authedApi()
    const { tableId } = await seedCsv(api, CSV)
    await context.addCookies((await api.storageState()).cookies)
    await page.goto(`${BASE}/table/${tableId}`)
    await expect(page.locator('.ag-row[row-index="0"]').first()).toBeVisible({ timeout: 15_000 })
    const downloaded = page.waitForEvent('download')
    await openDataMenu(page, 'Export for a CRM or email tool')
    const download = await downloaded
    expect(download.suggestedFilename()).toMatch(/\(for import\)\.csv$/)
    const body = await readFile((await download.path())!, 'utf8')
    expect(body).toContain(RAW_ROW)
  })
})
