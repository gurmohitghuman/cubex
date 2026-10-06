import { test, expect, request as pwRequest } from '@playwright/test'
import crypto from 'crypto'
import { createRequire } from 'module'
import path from 'path'
import { authedApi, seedSheet, makeAccessToken, BASE } from './helpers'
import { mcpClient, parseResult } from './helpers-run-results'

// One-time upload and download links (create_upload_link, create_download_link):
// a CSV file moves into or out of a sheet over plain HTTP, the way an agent
// runs curl, without its contents passing through MCP. A link works once, for
// its own operation, until it expires and while the token that made it is
// valid. An upload link needs the write scope, and a token without it is told
// what to do instead.

// The harness's throwaway database, for what no API does: ageing a link, or
// revoking the token behind it directly.
const require = createRequire(import.meta.url)
function inTestDb(sql: string, ...args: unknown[]) {
  const Database = require(path.join(process.cwd(), 'node_modules/better-sqlite3'))
  const db = new Database(process.env.DB_PATH)
  try { db.pragma('busy_timeout = 5000'); db.prepare(sql).run(...args) } finally { db.close() }
}
const tokenOf = (url: string) => url.split('/').pop()!
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

test('an upload link imports a file once and reports back; a form upload leaves it unused', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2) // val: v0, v1
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write'], 'links-up'), 'e2e-links-up')
  const http = await pwRequest.newContext()

  const link = parseResult(await client.callTool({ name: 'create_upload_link', arguments: { sheet_id: sheetId } }))
  expect(link.error, JSON.stringify(link)).toBeUndefined()
  expect(link.upload_url).toMatch(new RegExp(`^${BASE}/api/files/upload/[0-9a-f]{64}$`))
  expect(link.curl).toBe(`curl -sS -T <file.csv> '${link.upload_url}'`)
  expect(link.mode).toBe('append')

  const form = await http.post(link.upload_url, {
    multipart: { file: { name: 'leads.csv', mimeType: 'text/csv', buffer: Buffer.from('a\n1\n') } },
  })
  expect(form.status()).toBe(415)
  expect((await form.json()).error).toMatch(/curl -T/)
  // An empty file is refused up front, and the link still works.
  const empty = await http.put(link.upload_url, { data: Buffer.alloc(0) })
  expect(empty.status()).toBe(400)
  expect((await empty.json()).error).toMatch(/empty.*still works/)

  const csv = ['email,company,note', ...Array.from({ length: 1500 }, (_, i) => `p${i}@x.com,Co ${i},"Hi, ${i}"`)].join('\n')
  const up = await http.put(link.upload_url, { data: Buffer.from(csv), headers: { 'Content-Type': 'text/csv' } })
  expect(up.status()).toBe(201)
  expect(await up.json()).toEqual({ rows_imported: 1500, starting_row: 2, new_columns: ['email', 'company', 'note'], replaced: false })

  const again = await http.put(link.upload_url, { data: Buffer.from(csv) })
  expect(again.status()).toBe(404)
  const meta = parseResult(await client.callTool({ name: 'get_sheet', arguments: { sheet_id: sheetId } }))
  expect(meta.row_count).toBe(1502)

  // curl --data-binary sends a POST labelled as a form; the body still goes in
  // whole, as the CSV it is. Replace mode swaps every row for the file's.
  const replace = parseResult(await client.callTool({ name: 'create_upload_link', arguments: { sheet_id: sheetId, mode: 'replace' } }))
  const posted = await http.post(replace.upload_url, {
    data: Buffer.from('email,company\nz@z.com,Zed\n'), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  expect(posted.status()).toBe(201)
  expect(await posted.json()).toMatchObject({ rows_imported: 1, starting_row: 0, replaced: true })

  // A replace with a file that has no header row would empty the sheet: refused,
  // and the reply says the link is spent.
  const headless = parseResult(await client.callTool({ name: 'create_upload_link', arguments: { sheet_id: sheetId, mode: 'replace' } }))
  const refused = await http.put(headless.upload_url, { data: Buffer.from('\n\n') })
  expect(refused.status()).toBe(400)
  expect((await refused.json()).error).toMatch(/no header row.*used up/)
  expect(parseResult(await client.callTool({ name: 'get_sheet', arguments: { sheet_id: sheetId } })).row_count).toBe(1)

  for (const bad of [`${BASE}/api/files/upload/nothex`, `${BASE}/api/files/upload/${'0'.repeat(64)}`]) {
    expect((await http.put(bad, { data: Buffer.from('a\n1\n') })).status()).toBe(404)
  }
  await http.dispose()
  await client.close()
})

test('a download link saves the picked rows once; HEAD leaves it unused', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3) // val: v0..v2
  const client = await mcpClient(await makeAccessToken(api, ['read'], 'links-down'), 'e2e-links-down')
  const http = await pwRequest.newContext()
  const where = [{ column: 'val', operator: 'neq', value: 'v1' }]

  const link = parseResult(await client.callTool({ name: 'create_download_link', arguments: { sheet_id: sheetId, where } }))
  expect(link.download_url).toMatch(new RegExp(`^${BASE}/api/files/download/[0-9a-f]{64}$`))
  expect(link.curl).toBe(`curl -sS -f -o <file.csv> '${link.download_url}'`)

  expect((await http.head(link.download_url)).status()).toBe(405)
  const got = await http.get(link.download_url)
  expect(got.status()).toBe(200)
  expect(got.headers()['content-type']).toBe('text/csv; charset=utf-8')
  expect(got.headers()['content-disposition']).toMatch(/^attachment;/)
  expect(got.headers()['cache-control']).toBe('private, no-store')
  // The same bytes export_csv returns inline for the same filter.
  const inline = parseResult(await client.callTool({ name: 'export_csv', arguments: { sheet_id: sheetId, where } }))
  expect(await got.text()).toBe(inline.csv)
  expect(inline.csv).toBe('"val"\r\n"v0"\r\n"v2"')
  expect((await http.get(link.download_url)).status()).toBe(404)

  // A typo'd column fails when the link is asked for, not when it is used.
  const typo = await client.callTool({ name: 'create_download_link', arguments: { sheet_id: sheetId, columns: ['vall'] } })
  expect(typo.isError).toBe(true)
  expect(parseResult(typo).error).toMatch(/Unknown column/)
  await http.dispose()
  await client.close()
})

test('links stop working when they expire or their token is revoked', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 1)
  const token = await makeAccessToken(api, ['read', 'write'], 'links-life')
  const client = await mcpClient(token, 'e2e-links-life')
  const http = await pwRequest.newContext()
  const make = async () => parseResult(await client.callTool({ name: 'create_download_link', arguments: { sheet_id: sheetId } })).download_url

  const aged = await make()
  inTestDb("UPDATE file_links SET expires_at = datetime('now', '-1 second') WHERE token_hash = ?", sha(tokenOf(aged)))
  expect((await http.get(aged)).status()).toBe(404)

  const orphan = await make()
  inTestDb("UPDATE access_tokens SET revoked_at = datetime('now') WHERE token_hash = ?", sha(token))
  expect((await http.get(orphan)).status()).toBe(404)
  await http.dispose()
  await client.close()
})

test('a token without write is told it cannot make upload links, and what to do', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 1)
  const client = await mcpClient(await makeAccessToken(api, ['read'], 'links-ro'), 'e2e-links-ro')

  // Said up front, in the tool list this token sees...
  const tool = (await client.listTools()).tools.find(t => t.name === 'create_upload_link')!
  expect(tool.description).toContain('This token has no write permission')
  // ...and in full when called anyway: nothing happened, and the two ways on.
  const refused = await client.callTool({ name: 'create_upload_link', arguments: { sheet_id: sheetId } })
  expect(refused.isError).toBe(true)
  const message = parseResult(refused).error
  expect(message).toContain("'write' scope")
  expect(message).toContain('nothing was imported')
  expect(message).toContain('Agent access')
  expect(message).toContain('click Import')
  // Reading is still fine: a download link works with read alone.
  const down = parseResult(await client.callTool({ name: 'create_download_link', arguments: { sheet_id: sheetId } }))
  expect(down.download_url).toBeTruthy()
  await client.close()
})
