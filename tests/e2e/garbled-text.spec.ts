import { test, expect, request as pwRequest } from '@playwright/test'
import { authedApi, seedSheet, makeAccessToken, getSheet, BASE } from './helpers'
import { mcpClient, call } from './helpers-mcp'

// Text read with the wrong character set keeps the U+0080-U+009F characters
// that make it repairable: through an upload link, read_rows and a download
// link, and through the REST import and read, byte for byte. Every JSON answer
// writes them as \u0080-\u009f escapes (no raw C2 80-C2 9F on the wire) and
// parses to the same values; the CSV download keeps the raw bytes. The import
// counts the cells that look garbled (garbled_cells, garbled_samples: row ids
// and columns, no values, and one note); one without such cells answers
// exactly as before. clean_column's fix_encoding repairs what it can.

const VALUES = ['C1test\u0080\u0089end', 'FraudFighterâ\u0084¢', 'CODE Ã\u0089xitos']
const NOTES = ['plain', 'José', 'Łódź']
const CSV = ['Name,Note', ...VALUES.map((v, i) => `${v},${NOTES[i]}`)].join('\n') + '\n'
const garbledNote = (read: string, repair: string) => '3 cell(s) look like text read with the wrong character set. '
  + `garbled_samples lists the first ones by row id and column; ${read} with those row_ids shows their values. `
  + `${repair} with the cleaner fix_encoding can repair them into a new column.`
type Row = { id: string; data: Record<string, string> }

// The raw bytes of an answer: no C2 80-C2 9F pair, and (when it carries the values) their escapes.
const RAW_C1 = /\xC2[\x80-\x9F]/
function escapedOnTheWire(bytes: Buffer, carriesValues = true) {
  const text = bytes.toString('latin1')
  expect(text).not.toMatch(RAW_C1)
  if (carriesValues) for (const e of ['\\u0080', '\\u0089', '\\u0084']) expect(text).toContain(e)
}

// A tools/call as the bytes the server sends (MCP 2026-07-28, no initialize).
const MODERN = '2026-07-28'
async function rawToolCall(token: string, name: string, args: Record<string, unknown>): Promise<Buffer> {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call',
      'Mcp-Name': name },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args, _meta: {
      'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'e2e-raw', version: '1' } } } }),
  })
  expect(res.status).toBe(200)
  return Buffer.from(await res.arrayBuffer())
}

test('an upload link, read_rows and a download link keep C1 byte for byte; fix_encoding repairs', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 1) // val: v0
  const token = await makeAccessToken(api, ['read', 'write'], 'garbled-links')
  const client = await mcpClient(token, 'e2e-garbled')
  const http = await pwRequest.newContext()

  const link = await call(client, 'create_upload_link', { sheet_id: sheetId })
  const up = await http.put(link.upload_url,
    { data: Buffer.from(CSV, 'utf8'), headers: { 'Content-Type': 'text/csv' } })
  expect(up.status()).toBe(201)
  const answer = await up.json()
  escapedOnTheWire(await up.body(), false)
  expect((await up.body()).toString('utf8')).not.toContain(VALUES[1].slice(0, 12))

  const rows = (await call(client, 'read_rows', { sheet_id: sheetId })).rows as Row[]
  const imported = rows.slice(1)
  expect(imported.map(r => r.data.Name)).toEqual(VALUES)
  expect(imported.map(r => r.data.Note)).toEqual(NOTES)
  expect(Object.keys(answer)).toEqual(
    ['rows_imported', 'starting_row', 'new_columns', 'replaced', 'garbled_cells', 'garbled_samples', 'note'])
  expect(answer).toEqual({
    rows_imported: 3, starting_row: 1, new_columns: ['Name', 'Note'], replaced: false, garbled_cells: 3,
    garbled_samples: Object.fromEntries(imported.map(r => [r.id, ['Name']])),
    note: garbledNote('read_rows', 'clean_column'),
  })

  // read_rows on the wire: escapes only, the same values once parsed.
  const wire = await rawToolCall(token, 'read_rows', { sheet_id: sheetId })
  escapedOnTheWire(wire)
  const viaWire = JSON.parse(JSON.parse(wire.toString('utf8')).result.content[0].text).rows as Row[]
  expect(viaWire.slice(1).map(r => r.data.Name)).toEqual(VALUES)

  // The app's read of the sheet too.
  const appRead = await api.get(`/api/sheets/${sheetId}?limit=1000&offset=0`)
  escapedOnTheWire(await appRead.body())
  expect((await getSheet(api, sheetId)).data.rows.slice(1).map((r: Row) => r.data.Name)).toEqual(VALUES)

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
    escapedOnTheWire(await read.body())
    escapedOnTheWire(await res.body(), false)
    const imported = ((await read.json()).rows as Row[]).slice(1)
    expect(imported.map(r => r.data.Name)).toEqual(VALUES)
    expect(imported.map(r => r.data.Note)).toEqual(NOTES)
    expect(Object.keys(answer)).toEqual(['rows_imported', 'starting_row', 'new_columns', 'truncated_cells',
      'garbled_cells', 'garbled_samples', 'note', 'replaced', 'dropped_blank_starter_rows'])
    expect(answer).toEqual({
      rows_imported: 3, starting_row: 1, new_columns: ['Name', 'Note'], truncated_cells: 0, garbled_cells: 3,
      garbled_samples: Object.fromEntries(imported.map(r => [r.id, ['Name']])),
      note: garbledNote('POST /sheets/{id}/rows/query', 'POST /sheets/{id}/clean-columns'), replaced: false,
      dropped_blank_starter_rows: false,
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
