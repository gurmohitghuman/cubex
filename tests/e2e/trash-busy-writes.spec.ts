import { test, expect, request as pwRequest } from '@playwright/test'
import http from 'node:http'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { authedApi, seedSheet, makeAccessToken, BASE, assertTestDb } from './helpers'
import { call, mcpClient } from './helpers-mcp'

// A CSV import checks its sheet, then waits for the file: the sheet can go to
// the trash meanwhile. An upload link's import (the longest wait: up to the
// whole upload) then imports nothing and answers 404 "Sheet not found"; the
// sheet comes back from the trash as it was.

const require = createRequire(import.meta.url)
// Whether the server has taken the link (it marks it used before reading the file).
function linkTaken(url: string): boolean {
  const Database = require(path.join(process.cwd(), 'node_modules/better-sqlite3'))
  const db = new Database(assertTestDb(process.env.DB_PATH), { readonly: true })
  try {
    const hash = crypto.createHash('sha256').update(url.split('/').pop()!).digest('hex')
    return !!db.prepare('SELECT used_at FROM file_links WHERE token_hash = ?').pluck().get(hash)
  } finally { db.close() }
}

test('an upload link imports nothing into a sheet deleted while the file uploaded', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 2)
  await api.post(`/api/tables/${tableId}/sheets`, { data: { name: 'Spare' } })
  const token = await makeAccessToken(api, ['read', 'write'], 'e2e trash upload')
  const client = await mcpClient(token, 'e2e trash upload')
  const v1 = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${token}` } })
  const rows = async () => (await (await v1.get(`/api/v1/sheets/${sheetId}/rows`)).json()).rows
  const before = await rows()
  const link = await call(client, 'create_upload_link', { sheet_id: sheetId })

  const file = Buffer.from('val,extra\nnew1,x\nnew2,y\n')
  const put = http.request(link.upload_url, {
    method: 'PUT', headers: { 'Content-Type': 'text/csv', 'Content-Length': file.length },
  })
  const answer = new Promise<{ status: number; body: string }>((resolve, reject) => {
    put.on('response', res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, body }))
    })
    put.on('error', reject)
  })
  put.write(file.subarray(0, 12))
  await expect.poll(() => linkTaken(link.upload_url), { timeout: 10_000 }).toBe(true)
  // The file is arriving: the sheet goes to the trash now, and the rest of the file after.
  const gone = await api.delete(`/api/tables/${tableId}/sheets/${sheetId}`)
  expect(gone.status(), await gone.text()).toBe(200)
  put.end(file.subarray(12))
  const out = await answer
  expect(out.status, out.body).toBe(404)
  expect(JSON.parse(out.body)).toEqual({ error: 'Sheet not found. This link is used up; ask for a new one.' })

  const back = await (await api.post('/api/trash/restore', { data: { ids: [(await gone.json()).trash.id] } })).json()
  expect(back.results[0].restored).toMatchObject({ state: 'restored' })
  expect(await rows()).toEqual(before)
  const sheet = await v1.get(`/api/v1/sheets/${sheetId}`)
  expect(sheet.status()).toBe(200)
  expect(JSON.stringify(await sheet.json())).not.toContain('"extra"')
  await client.close()
  await v1.dispose()
})
