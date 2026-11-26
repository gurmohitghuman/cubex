// Who may act on a sheet's webhook (services/sheet-webhook.ts, the one service the app, REST and MCP call; the
// test gaps left by #145's audit): another account's every action on someone else's sheet, and on a field id of
// someone else's webhook, is "not found" and changes nothing, its URL never shown; a sheet in the trash answers
// the same for its owner; and a webhook asked for with a new sheet that can't get one comes back as
// webhook_error beside the sheet.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import busyMod from '../../server/src/lib/sheet-busy'
import svcMod from '../../server/src/services/sheet-webhook'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { withSheetBusy, busyMessage } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const S = svcMod as typeof import('../../server/src/services/sheet-webhook')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

function account(): { uid: string; sheet: (name: string) => string } {
  const uid = uuid(), tid = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
  return { uid, sheet: name => {
    const id = uuid()
    db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
      .run(id, tid, uid, name, JSON.stringify(['Name']))
    return id
  } }
}
const a = account(), b = account()
const aSheet = a.sheet('Leads'), bSheet = b.sheet('Mine')
for (const [who, sid] of [[a.uid, aSheet], [b.uid, bSheet]] as const) {
  const made = S.createSheetWebhook(who, sid)
  assert.ok('ok' in made, JSON.stringify(made))
  assert.ok('ok' in S.addSheetWebhookField(who, sid, { jsonPath: '$.email', column: 'Email', asJson: false }))
}
const aField = db.prepare(`SELECT m.id FROM webhook_mappings m JOIN webhook_sources s ON s.id = m.source_id
  WHERE s.sheet_id = ?`).pluck().get(aSheet) as string
const snapshot = (sid: string) => JSON.stringify([
  db.prepare('SELECT enabled, token_hash, auth_token_hash FROM webhook_sources WHERE sheet_id = ?').get(sid),
  db.prepare(`SELECT m.id, m.column_name FROM webhook_mappings m JOIN webhook_sources s ON s.id = m.source_id
    WHERE s.sheet_id = ? ORDER BY m.id`).all(sid),
  db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck().get(sid),
])
// Every action, as `who` on `sid`.
const actions = (who: string, sid: string, fieldId: string) => ({
  get: () => S.getSheetWebhook(who, sid),
  create: () => S.createSheetWebhook(who, sid),
  turn_off: () => S.setSheetWebhookEnabled(who, sid, false),
  rotate: () => S.rotateSheetWebhook(who, sid),
  new_token: () => S.newSheetWebhookToken(who, sid),
  remove_token: () => S.removeSheetWebhookToken(who, sid),
  add_field: () => S.addSheetWebhookField(who, sid, { jsonPath: '$.x', column: 'X', asJson: false }),
  remove_field: () => S.removeSheetWebhookField(who, sid, fieldId),
  delete: () => S.deleteSheetWebhook(who, sid),
})

let failures = 0
function check(label: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(() => console.log('ok  ', label), e => {
    failures++; console.log('FAIL', label, '\n ', (e as Error).message)
  })
}

await check("another account: every action on someone else's sheet is 'Sheet not found', and changes nothing", () => {
  const before = snapshot(aSheet)
  for (const [name, act] of Object.entries(actions(b.uid, aSheet, aField))) {
    assert.deepEqual(act(), { fail: 'not_found', message: 'Sheet not found' }, name)
  }
  assert.equal(snapshot(aSheet), before)
})

await check("another account's field id on one's own webhook: 'Field not found', both webhooks as they were", () => {
  const [mine, theirs] = [snapshot(bSheet), snapshot(aSheet)]
  assert.deepEqual(S.removeSheetWebhookField(b.uid, bSheet, aField), { fail: 'not_found', message: 'Field not found.' })
  assert.deepEqual([snapshot(bSheet), snapshot(aSheet)], [mine, theirs])
})

await check("a sheet in the trash: every action is 'Sheet not found' for its owner too", () => {
  const trashed = a.sheet('Old')
  assert.ok('ok' in S.createSheetWebhook(a.uid, trashed))
  db.prepare('UPDATE sheets SET trash_id = 1 WHERE id = ?').run(trashed)
  const before = snapshot(trashed)
  for (const [name, act] of Object.entries(actions(a.uid, trashed, aField))) {
    assert.deepEqual(act(), { fail: 'not_found', message: 'Sheet not found' }, name)
  }
  assert.equal(snapshot(trashed), before)
})

await check('a new sheet that can\'t get its webhook (busy) answers webhook_error beside it', async () => {
  const fresh = a.sheet('New')
  let release!: () => void
  const held = withSheetBusy(fresh, 'import', () => new Promise<void>(r => { release = r }))
  try {
    assert.deepEqual(S.webhookForNewSheet(a.uid, fresh, 'https://cubex.example.com'),
      { webhook_error: busyMessage('import') })
  } finally { release(); await held }
  const out = S.webhookForNewSheet(a.uid, fresh, 'https://cubex.example.com')
  assert.ok('webhook' in out && out.webhook.url?.startsWith('https://cubex.example.com/api/webhooks/'),
    JSON.stringify(out))
})

if (failures > 0) { console.error(`${failures} sheet-webhook-access check(s) failed`); process.exit(1) }
console.log('sheet-webhook-access: all assertions passed')
