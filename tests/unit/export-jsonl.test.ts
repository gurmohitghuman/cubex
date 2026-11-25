// JSON lines downloads (lib/csv-write.ts writeSheetJsonl): GET /api/v1/sheets/:id/export?format=jsonl and a
// create_download_link link made with format jsonl give one {"id", "data"} object a line, as read_rows answers a
// row: every exported column in data in the export's order, '' where the row has no value, numbers and true/false
// keeping their type, no formula quote, a column named "id" or "constructor" kept apart from the row id and from
// inherited members. The rows and order are the CSV's (a where, the columns asked for); the file is
// application/x-ndjson with a .jsonl name; an empty sheet is an empty body; another format is a 400; and CSV is
// unchanged as the default. More than one page (5,000 rows) streams whole.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
const express = (await import('express')).default
const { v4: uuid } = await import('uuid')
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { createFileLink, fileLinkUrl } = await import('../../server/src/lib/file-links')
const { generateAccessToken } = await import('../../server/src/lib/access-token')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).message)
  }
}

const uid = uuid(), tid = uuid(), tokenId = uuid()
db.prepare('INSERT INTO users (id, password_hash) VALUES (?, ?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?, ?, ?)').run(tid, uid, 'T')
const insertRow = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)')
function sheet(name: string, columns: string[], rows: Array<Record<string, unknown>>): { sid: string; ids: string[] } {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?, ?, ?, ?, ?)')
    .run(sid, tid, uid, name, JSON.stringify(columns))
  const ids = rows.map(() => uuid())
  db.transaction(() => rows.forEach((r, i) => insertRow.run(ids[i], sid, uid, i, JSON.stringify(r)))).immediate()
  return { sid, ids }
}
const COLUMNS = ['Name', 'id', 'Score', 'Won', 'Notes', 'constructor']
const leads = sheet('Leads', COLUMNS, [
  { Name: 'Ada', id: 'lead-1', Score: 92, Won: true, Notes: 'two\nlines', constructor: 'c' },
  { Name: '=HYPERLINK("x")', Score: 0, Won: false, Notes: '' },
  { Name: 'Zoë 🚀', id: '' },
])
const empty = sheet('Empty', ['A'], [])
const big = sheet('Big', ['N'], Array.from({ length: 12_345 }, (_, i) => ({ N: i })))

const pat = generateAccessToken()
db.prepare('INSERT INTO access_tokens (id,user_id,name,token_hash,token_prefix,scopes) VALUES (?,?,?,?,?,?)')
  .run(tokenId, uid, 'agent', pat.tokenHash, pat.tokenPrefix, 'read')

const app = express()
app.use('/api/files', (await import('../../server/src/routes/file-links')).default)
app.use('/api/v1', (await import('../../server/src/routes/api-v1')).default)
const server = app.listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const get = (path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${pat.token}` } })
const lines = (text: string) => text.split('\n').filter(Boolean).map(l => JSON.parse(l))

const expected = [
  {
    id: leads.ids[0],
    data: { Name: 'Ada', id: 'lead-1', Score: 92, Won: true, Notes: 'two\nlines', constructor: 'c' },
  },
  { id: leads.ids[1], data: { Name: '=HYPERLINK("x")', id: '', Score: 0, Won: false, Notes: '', constructor: '' } },
  { id: leads.ids[2], data: { Name: 'Zoë 🚀', id: '', Score: '', Won: '', Notes: '', constructor: '' } },
]

await check('REST ?format=jsonl: one {id, data} line a row, every column, types kept, no formula quote', async () => {
  const res = await get(`/api/v1/sheets/${leads.sid}/export?format=jsonl`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/x-ndjson; charset=utf-8')
  assert.match(res.headers.get('content-disposition') ?? '', /filename="Leads\.jsonl"/)
  const text = await res.text()
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), 'each line ends with one line feed')
  const got = lines(text)
  assert.deepEqual(got, expected)
  assert.deepEqual(Object.keys(got[0].data), COLUMNS, 'the export\'s column order')
})

await check('CSV stays the default, and ?format=csv the same', async () => {
  for (const q of ['', '?format=csv']) {
    const res = await get(`/api/v1/sheets/${leads.sid}/export${q}`)
    assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8')
    const text = await res.text()
    assert.ok(text.startsWith('"Name","id","Score"'), text.slice(0, 40))
    assert.ok(text.includes(`"'=HYPERLINK(""x"")"`), 'the CSV keeps its formula quote')
  }
})

await check('another format is a 400; an empty sheet is an empty body', async () => {
  const bad = await get(`/api/v1/sheets/${leads.sid}/export?format=xml`)
  assert.equal(bad.status, 400)
  assert.deepEqual(await bad.json(), { error: 'format is csv or jsonl.' })
  const none = await get(`/api/v1/sheets/${empty.sid}/export?format=jsonl`)
  assert.equal(none.status, 200)
  assert.equal(none.headers.get('content-type'), 'application/x-ndjson; charset=utf-8')
  assert.equal(await none.text(), '')
})

await check('a download link made with format jsonl: the columns and rows asked for, in that order', async () => {
  const link = createFileLink({ userId: uid, tokenId, sheetId: leads.sid, kind: 'download', options: {
    columns: ['Score', 'Name'], where: [{ column: 'Won', operator: 'not_empty' }], format: 'jsonl' } })
  const res = await fetch(fileLinkUrl(base, 'download', link.token))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/x-ndjson; charset=utf-8')
  assert.match(res.headers.get('content-disposition') ?? '', /\.jsonl"/)
  assert.deepEqual(lines(await res.text()), [
    { id: leads.ids[0], data: { Score: 92, Name: 'Ada' } },
    { id: leads.ids[1], data: { Score: 0, Name: '=HYPERLINK("x")' } },
  ])
  assert.equal((await fetch(fileLinkUrl(base, 'download', link.token))).status, 404, 'the link works once')
})

await check('a link without a format (as every link made before) is still CSV', async () => {
  const link = createFileLink({ userId: uid, tokenId, sheetId: leads.sid, kind: 'download', options: {} })
  const res = await fetch(fileLinkUrl(base, 'download', link.token))
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8')
  assert.match(res.headers.get('content-disposition') ?? '', /\.csv"/)
})

await check('12,345 rows (three pages) stream whole, in row order, each with its id', async () => {
  const got = lines(await (await get(`/api/v1/sheets/${big.sid}/export?format=jsonl`)).text())
  assert.equal(got.length, 12_345)
  got.forEach((l, i) => {
    if (l.id !== big.ids[i] || l.data.N !== i) assert.fail(`row ${i}: ${JSON.stringify(l)}`)
  })
})

server.close()
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('export jsonl: all passed')
