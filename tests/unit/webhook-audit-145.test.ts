// Two findings of #145's audit (2026-11-25). A field can't be added on a column the webhook already owns, even
// when a CSV replace has taken it off the sheet (services/webhook-mapping-add.ts): its marker (each event stamps
// it) and a column a field of it fills (the one-field-a-column index used to answer 500) are refused in words.
// And the webhook's own controls go through REST's busy guard and the app's real sheets router while a sort holds
// the sheet (lib/sheet-busy.ts webhookControl), so a leaked URL can be cut off mid-import, while setting one up and
// adding or removing a field still get 409 busy.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import express from 'express'
import cookieParser from 'cookie-parser'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import busyMod from '../../server/src/lib/sheet-busy'
import whMod from '../../server/src/lib/webhook-service'
import addMod from '../../server/src/services/webhook-mapping-add'
import sharedMod from '../../server/src/routes/api-v1-shared'
import authMod from '../../server/src/lib/auth'
import sheetsMod from '../../server/src/routes/sheets'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { withSheetBusy, refuseChangesWhileBusy } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { createSourceWithColumn } = whMod as typeof import('../../server/src/lib/webhook-service')
const { addWebhookMapping } = addMod as typeof import('../../server/src/services/webhook-mapping-add')
const { V1_SHEET_BUSY_ALLOWED } = sharedMod as typeof import('../../server/src/routes/api-v1-shared')
const { signToken } = authMod as typeof import('../../server/src/lib/auth')
const { default: sheetsRouter } = sheetsMod as unknown as typeof import('../../server/src/routes/sheets')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
  .run(sid, tid, uid, 'Leads', JSON.stringify(['Name']))
createSourceWithColumn(sid, uid, 'Webhook')
const src = db.prepare('SELECT id FROM webhook_sources WHERE sheet_id = ?').pluck().get(sid) as string
const add = (column: string) =>
  addWebhookMapping(sid, uid, src, { jsonPath: '$.v', columnName: column, valueMode: 'scalar' })

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).message)
  }
}

await check('after a replace took its columns off the sheet, a field on one of them is refused in words', () => {
  assert.deepEqual(add('Email'), { ok: true, column: 'Email' })
  // A CSV replace: the sheet lists only the file's columns now.
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(['Name']), sid)
  const again = add('email')
  assert.ok('fail' in again && again.fail === 'invalid', JSON.stringify(again))
  assert.match(again.error, /^The webhook already fills "Email"/)
  const marker = add('Webhook')
  assert.ok('fail' in marker && marker.fail === 'invalid', JSON.stringify(marker))
  assert.match(marker.error, /^"Webhook" is the webhook's own column/)
  assert.equal(db.prepare('SELECT COUNT(*) FROM webhook_mappings WHERE source_id = ?').pluck().get(src), 1)
  assert.deepEqual(add('Phone'), { ok: true, column: 'Phone' }, 'another name is fine')
})

// REST's guard (V1_SHEET_BUSY_ALLOWED, mounted at /sheets/:id, before the routes).
await check("REST, a busy sheet: the webhook's controls go through; its columns' changes 409", async () => {
  const app = express()
  app.use('/sheets/:id', refuseChangesWhileBusy(V1_SHEET_BUSY_ALLOWED))
  app.use((_req, res) => { res.json({ through: true }) })
  const server = app.listen(0, '127.0.0.1')
  await new Promise(r => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sheets/${sid}`
  const status = async (method: string, path: string) => (await fetch(`${base}${path}`, { method })).status
  let release!: () => void
  const sorting = withSheetBusy(sid, 'sort', () => new Promise<void>(r => { release = r }))
  try {
    for (const [method, path] of [['PATCH', '/webhook'], ['POST', '/webhook/rotate'], ['POST', '/webhook/token'],
      ['DELETE', '/webhook/token'], ['DELETE', '/webhook']]) {
      assert.equal(await status(method, path), 200, `${method} ${path}`)
    }
    for (const [method, path] of [['POST', '/webhook'], ['POST', '/webhook/fields'],
      ['DELETE', '/webhook/fields/f1'], ['PATCH', '/rows']]) {
      assert.equal(await status(method, path), 409, `${method} ${path}`)
    }
  } finally {
    release()
    await sorting
    server.close()
  }
})

// The app's: its real sheets router (routes/sheets.ts, guard and routes), signed in, so each control's change is
// made and seen in the database while a sort holds the sheet.
await check("the app, a busy sheet: the webhook's controls go through and change it; its columns' changes 409",
  async () => {
    const app = express()
    app.use(cookieParser())
    app.use(express.json())
    app.use('/api/sheets', sheetsRouter)
    const server = app.listen(0, '127.0.0.1')
    await new Promise(r => server.once('listening', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sheets/${sid}`
    const cookie = `cubex_session=${signToken({ userId: uid, sessionEpoch: 0 })}`
    const call = async (method: string, path: string, body?: unknown) => (await fetch(`${base}${path}`, {
      method, headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })).status
    const state = () => db.prepare('SELECT enabled, token_hash, auth_token_hash FROM webhook_sources WHERE id = ?')
      .get(src) as { enabled: number; token_hash: string; auth_token_hash: string | null } | undefined
    let release!: () => void
    const sorting = withSheetBusy(sid, 'sort', () => new Promise<void>(r => { release = r }))
    try {
      const before = state()!
      assert.equal(await call('PATCH', '/webhook', { enabled: false }), 200, 'turn off')
      assert.equal(state()!.enabled, 0)
      assert.equal(await call('POST', '/webhook/rotate'), 200, 'rotate')
      assert.notEqual(state()!.token_hash, before.token_hash)
      assert.equal(await call('POST', '/webhook/token'), 200, 'new token')
      assert.ok(state()!.auth_token_hash)
      assert.equal(await call('DELETE', '/webhook/token'), 200, 'remove token')
      assert.equal(state()!.auth_token_hash, null)
      const fields = db.prepare('SELECT COUNT(*) FROM webhook_mappings WHERE source_id = ?').pluck()
      const had = fields.get(src)
      assert.equal(await call('POST', '/webhook/mappings', { jsonPath: '$.w', columnName: 'W' }), 409, 'add field')
      assert.equal(await call('DELETE', '/webhook/mappings/f1'), 409, 'remove field')
      assert.equal(await call('PUT', '/columns/Name', { newName: 'Name 2' }), 409, 'rename a column')
      assert.equal(fields.get(src), had)
      assert.equal(await call('DELETE', '/webhook'), 200, 'delete')
      assert.equal(state(), undefined)
      assert.equal(await call('POST', '/webhook'), 409, 'set one up')
    } finally {
      release()
      await sorting
      server.close()
    }
  })

if (failures > 0) { console.error(`${failures} webhook-audit-145 check(s) failed`); process.exit(1) }
console.log('webhook-audit-145: all assertions passed')
