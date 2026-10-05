import { test, expect, request as pwRequest } from '@playwright/test'
import { authedApi, seedSheet, getSheet } from './helpers'

// P2-9 regression: webhook ingestion must strip control characters from cell
// values, like every other input path (cell edits, CSV import). Before the fix,
// valueToCell truncated but never stripped — the one input surface that let
// NUL/backspace/C1 controls into rows.data. Tab/newline are preserved.
//
// Also the FIRST e2e that exercises the webhook create -> map -> deliver -> read
// flow end to end (this surface previously had zero coverage).


// Build the value with explicit escapes so no raw control byte lives in source:
// "a" NUL "b" C1(0x8A) "c" TAB "d" LF "e". Controls must be stripped; the
// tab (0x09) and newline (0x0A) must survive.
const NUL = String.fromCharCode(0x00)
const C1 = String.fromCharCode(0x8a)
const PAYLOAD_VALUE = `a${NUL}b${C1}c\td\ne`

test('webhook ingestion strips control chars from cell values (tab/newline kept)', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 1)

  // Create the webhook source (+ marker column) and a mapping for "name".
  const created = await api.post(`/api/sheets/${sheetId}/webhook`, { data: { name: 'e2e hook' } })
  expect(created.status()).toBe(201)
  const url: string = (await created.json()).source.url
  expect(url).toBeTruthy()

  const mapped = await api.post(`/api/sheets/${sheetId}/webhook/mappings`, {
    data: { jsonPath: '$.name', columnName: 'name' },
  })
  expect(mapped.ok()).toBeTruthy()

  // Deliver the payload to the PUBLIC webhook URL (unauthenticated).
  const anon = await pwRequest.newContext()
  const delivered = await anon.post(url, {
    headers: { 'Content-Type': 'application/json' },
    data: { name: PAYLOAD_VALUE },
  })
  expect(delivered.ok()).toBeTruthy()
  await anon.dispose()

  // The appended row's "name" cell has controls removed, tab/newline preserved.
  const sheet = await getSheet(api, sheetId)
  const rows = sheet.data.rows as Array<{ data: Record<string, string> }>
  const values = rows.map(r => r.data.name).filter(Boolean)
  expect(values.length).toBeGreaterThan(0)
  const cell = values[values.length - 1]

  expect(cell.includes(NUL)).toBe(false)             // NUL stripped
  expect(cell.includes(C1)).toBe(false)              // C1 control stripped
  expect(cell).toContain('\t')                       // tab preserved
  expect(cell).toContain('\n')                       // newline preserved
  expect(cell.replace(/[\t\n]/g, '')).toBe('abcde')  // visible text intact
})
