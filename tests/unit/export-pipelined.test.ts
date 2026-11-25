// Downloads pipelined on one connection (lib/csv-write.ts responseTurn, lib/csv-export.ts streamSheetCsv): Node
// answers them in order, so the second one's sheet is held only once its response owns the socket. A client that
// sends two requests at once and reads nothing keeps the first export waiting on its writes: its sheet is held,
// the second's is not. Once it reads, both arrive whole and in order, and neither sheet is held after. The second
// reads its sheet when its turn comes: a column renamed while it waited comes out under its new name.
import assert from 'node:assert/strict'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import exportMod from '../../server/src/lib/csv-export'
import busyMod from '../../server/src/lib/sheet-busy'
import renameMod from '../../server/src/services/column-rename'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { streamSheetCsv } = exportMod as typeof import('../../server/src/lib/csv-export')
const { sheetHeld } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { renameSheetColumn } = renameMod as typeof import('../../server/src/services/column-rename')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
function sheet(name: string, rows: number, pad: number): string {
  const id = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
    .run(id, tid, uid, name, JSON.stringify(['Name', 'Note']))
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < rows; i++) {
      ins.run(uuid(), id, uid, i, JSON.stringify({ Name: `${name}${i}`, Note: 'x'.repeat(pad) }))
    }
  }).immediate()
  return id
}
// Far more than the socket buffers hold (some MB on macOS), so the first export waits on its writes.
const big = sheet('Big', 40_000, 400)
// Past what a queued response buffers before its writes wait (16 KB): the second export waits on them too.
const small = sheet('Small', 1_000, 400)

const app = express()
app.get('/x/:id', async (req, res) => {
  const out = await streamSheetCsv(req.params.id, uid, res)
  if (out !== 'ok' && !res.headersSent && !res.destroyed) res.status(500).end(JSON.stringify(out))
})
const server = app.listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const port = (server.address() as AddressInfo).port
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let failures = 0
async function check(label: string, fn: () => Promise<void>) {
  try { await fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).message)
  }
}

await check('two downloads on one connection, nothing read: the first sheet held, the second not', async () => {
  const sock = net.connect(port, '127.0.0.1')
  await new Promise(r => sock.once('connect', r))
  sock.pause()
  sock.write(`GET /x/${big} HTTP/1.1\r\nHost: x\r\n\r\n`
    + `GET /x/${small} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
  await sleep(1_000)
  assert.equal(sheetHeld(big), true, 'the first export waits on its writes, its sheet held')
  assert.equal(sheetHeld(small), false, 'the second sheet is held while the first export has the connection')
  // Read it all: both answers, in order, whole.
  const chunks: Buffer[] = []
  sock.on('data', c => chunks.push(c))
  const ended = new Promise(r => sock.once('end', r))
  sock.resume()
  await ended
  const text = Buffer.concat(chunks).toString()
  assert.equal(text.split('HTTP/1.1 200').length - 1, 2, text.slice(0, 300))
  assert.ok(text.indexOf('Big39999') < text.indexOf('Small0'), 'in order')
  assert.ok(text.includes('Small999'), 'the second whole')
  assert.deepEqual([sheetHeld(big), sheetHeld(small)], [false, false])
  sock.destroy()
})

await check('... and the second answers for its sheet as it is at its turn: a column renamed meanwhile', async () => {
  const sock = net.connect(port, '127.0.0.1')
  await new Promise(r => sock.once('connect', r))
  sock.pause()
  sock.write(`GET /x/${big} HTTP/1.1\r\nHost: x\r\n\r\n`
    + `GET /x/${small} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
  await sleep(1_000)
  const renamed = await renameSheetColumn(small, uid, 'Note', 'Memo')
  assert.ok('ok' in renamed, JSON.stringify(renamed))
  const chunks: Buffer[] = []
  sock.on('data', c => chunks.push(c))
  const ended = new Promise(r => sock.once('end', r))
  sock.resume()
  await ended
  const text = Buffer.concat(chunks).toString()
  const second = text.slice(text.lastIndexOf('HTTP/1.1 200'))
  assert.ok(second.includes('"Name","Memo"\r\n'), second.slice(0, 300))
  assert.ok(second.includes(`"Small999","${'x'.repeat(400)}"`), 'its values under the new name')
  sock.destroy()
})

server.close()
if (failures > 0) { console.error(`${failures} export-pipelined check(s) failed`); process.exit(1) }
console.log('export-pipelined: all assertions passed')
