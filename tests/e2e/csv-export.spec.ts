import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, setSheetName } from './helpers'

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
