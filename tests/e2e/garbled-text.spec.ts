import { test, expect, request as pwRequest } from '@playwright/test'
import { authedApi, seedSheet, makeAccessToken, BASE } from './helpers'
import { mcpClient, call } from './helpers-mcp'

// Text read with the wrong character set keeps the U+0080-U+009F characters
// that make it repairable: through an upload link, read_rows and a download
// link, and through the REST import and read, byte for byte. The import counts
// the cells that look garbled (garbled_cells, garbled_samples keyed by row id
// and column, one note); one without such cells answers exactly as before.
// clean_column's fix_encoding repairs what it can and leaves the rest as it is.

const VALUES = ['C1test\u0080\u0089end', 'FraudFighterâ\u0084¢', 'CODE Ã\u0089xitos']
const NOTES = ['plain', 'José', 'Łódź']
const CSV = ['Name,Note', ...VALUES.map((v, i) => `${v},${NOTES[i]}`)].join('\n') + '\n'
const garbledNote = (repair: string) => '3 cell(s) look like text read with the wrong character set (garbled_samples '
  + `shows the first ones). ${repair} with the cleaner fix_encoding can repair them into a new column.`
type Row = { id: string; data: Record<string, string> }

test('an upload link, read_rows and a download link keep C1 byte for byte; fix_encoding repairs', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 1) // val: v0
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write'], 'garbled-links'), 'e2e-garbled')
  const http = await pwRequest.newContext()

  const link = await call(client, 'create_upload_link', { sheet_id: sheetId })
  const up = await http.put(link.upload_url,
    { data: Buffer.from(CSV, 'utf8'), headers: { 'Content-Type': 'text/csv' } })
  expect(up.status()).toBe(201)
  const answer = await up.json()

  const rows = (await call(client, 'read_rows', { sheet_id: sheetId })).rows as Row[]
  const imported = rows.slice(1)
  expect(imported.map(r => r.data.Name)).toEqual(VALUES)
  expect(imported.map(r => r.data.Note)).toEqual(NOTES)
  expect(Object.keys(answer)).toEqual(
    ['rows_imported', 'starting_row', 'new_columns', 'replaced', 'garbled_cells', 'garbled_samples', 'note'])
  expect(answer).toEqual({
    rows_imported: 3, starting_row: 1, new_columns: ['Name', 'Note'], replaced: false, garbled_cells: 3,
    garbled_samples: Object.fromEntries(imported.map((r, i) => [r.id, { Name: VALUES[i] }])),
    note: garbledNote('clean_column'),
  })

  const download = await call(client, 'create_download_link', { sheet_id: sheetId })
  const got = await http.get(download.download_url)
  expect(got.status()).toBe(200)
  const want = ['"val","Name","Note"', '"v0","",""', ...VALUES.map((v, i) => `"","${v}","${NOTES[i]}"`)].join('\r\n')
  expect((await got.body()).toString('hex')).toBe(Buffer.from(want, 'utf8').toString('hex'))

  const fixed = await call(client, 'clean_column',
    { sheet_id: sheetId, source_column: 'Name', cleaner: 'fix_encoding' })
  expect(fixed).toMatchObject({ column: 'Name (clean)', status: 'done', cleaned_rows: 3 })
  const after = (await call(client, 'read_rows', { sheet_id: sheetId })).rows as Row[]
  expect(after.slice(1).map(r => r.data['Name (clean)'])).toEqual([VALUES[0], 'FraudFighter™', 'CODE Éxitos'])
  expect(after.slice(1).map(r => r.data.Name)).toEqual(VALUES)

  await http.dispose()
  await client.close()
})

test('the REST import and a REST read keep C1 byte for byte; a file without garbled cells answers as before',
  async () => {
    const api = await authedApi()
    const { sheetId } = await seedSheet(api, 1)
    const token = await makeAccessToken(api, ['read', 'write'], 'garbled-rest')
    const v1 = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` } })
    const send = (csv: string) => v1.post(`/api/v1/sheets/${sheetId}/import`, {
      multipart: { file: { name: 'g.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') } },
    })

    const res = await send(CSV)
    expect(res.status()).toBe(201)
    const answer = await res.json()
    const read = await v1.get(`/api/v1/sheets/${sheetId}/rows?limit=10`)
    expect(read.status()).toBe(200)
    const imported = ((await read.json()).rows as Row[]).slice(1)
    expect(imported.map(r => r.data.Name)).toEqual(VALUES)
    expect(imported.map(r => r.data.Note)).toEqual(NOTES)
    expect(Object.keys(answer)).toEqual(['rows_imported', 'starting_row', 'new_columns', 'truncated_cells',
      'garbled_cells', 'garbled_samples', 'note', 'replaced', 'dropped_blank_starter_rows'])
    expect(answer).toEqual({
      rows_imported: 3, starting_row: 1, new_columns: ['Name', 'Note'], truncated_cells: 0, garbled_cells: 3,
      garbled_samples: Object.fromEntries(imported.map((r, i) => [r.id, { Name: VALUES[i] }])),
      note: garbledNote('POST /sheets/{id}/clean-columns'), replaced: false, dropped_blank_starter_rows: false,
    })

    const plain = await send('Name,Note\nAda,José\n')
    expect(plain.status()).toBe(201)
    const plainAnswer = await plain.json()
    expect(Object.keys(plainAnswer)).toEqual(
      ['rows_imported', 'starting_row', 'new_columns', 'truncated_cells', 'replaced', 'dropped_blank_starter_rows'])
    expect(plainAnswer).toEqual({
      rows_imported: 1, starting_row: 4, new_columns: [], truncated_cells: 0, replaced: false,
      dropped_blank_starter_rows: false,
    })
    await v1.dispose()
  })
