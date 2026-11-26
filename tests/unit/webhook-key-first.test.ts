// A webhook delivery's Idempotency-Key is looked up before what the sheet's state could refuse (lib/webhook-ingest.ts,
// as a token run start's key since #53 and transfer_rows' since #168): a sender retrying a delivery the sheet
// already took gets the same answer (a repeat, 202) once the sheet is full, where a new event gets 409; and the
// repeat adds, logs and counts nothing. MAX_ROWS_PER_SHEET is 3 here, read before the server's modules load.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
process.env.MAX_ROWS_PER_SHEET = '3'
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { appendWebhookDelivery } = await import('../../server/src/lib/webhook-ingest')
runMigrations()

const uid = uuid(), tid = uuid(), sid = uuid(), src = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
  .run(sid, tid, uid, 'Leads', JSON.stringify(['Webhook', 'Email']))
db.prepare(`INSERT INTO webhook_sources (id, user_id, sheet_id, token_hash, raw_column_name)
  VALUES (?,?,?,?,?)`).run(src, uid, sid, 'hash-1', 'Webhook')
db.prepare(`INSERT INTO webhook_mappings (id, source_id, user_id, json_path, column_name) VALUES (?,?,?,?,?)`)
  .run(uuid(), src, uid, '$.mail', 'Email')

const source = () => db.prepare('SELECT * FROM webhook_sources WHERE id = ?').get(src) as
  Parameters<typeof appendWebhookDelivery>[0]
const mappings = () => db.prepare('SELECT json_path, column_name, value_mode FROM webhook_mappings WHERE source_id = ?')
  .all(src) as Parameters<typeof appendWebhookDelivery>[1]
const send = (body: Record<string, unknown>, key: string | null) =>
  appendWebhookDelivery(source(), mappings(), body, JSON.stringify(body), { idempotencyKey: key, tokenHash: 'hash-1' })
const count = (sql: string) => db.prepare(sql).pluck().get(sid) as number
const rows = () => count('SELECT count(*) FROM rows WHERE sheet_id = ?')
const logged = () => count(`SELECT count(*) FROM webhook_deliveries d JOIN webhook_sources s ON s.id = d.source_id
  WHERE s.sheet_id = ?`)
const received = () => count('SELECT total_received FROM webhook_sources WHERE sheet_id = ?')

for (const [i, key] of ['evt-1', 'evt-2', null].entries()) {
  const r = send({ mail: `m${i}@x.com` }, key)
  assert.ok(r.ok && r.status === 'stored', JSON.stringify(r))
}
assert.equal(rows(), 3, 'the sheet is full')
const before = [logged(), received()]

const fresh = send({ mail: 'new@x.com' }, 'evt-3')
assert.deepEqual(fresh, { ok: false, code: 409, reason: 'Sheet is full' })
console.log('ok   a new event on a full sheet: 409')

const again = send({ mail: 'm1@x.com' }, 'evt-2')
assert.ok(again.ok && again.status === 'repeat', JSON.stringify(again))
assert.deepEqual([rows(), logged(), received()], [3, ...before], 'a repeat adds, logs and counts nothing')
console.log('ok   a retry of a delivery the sheet took, once it is full: the repeat answer, nothing added')

const other = send({ mail: 'other@x.com' }, 'evt-2')
assert.deepEqual(other, { ok: false, code: 409, reason: 'Sheet is full' })
console.log('ok   the same key with another body is a new event: 409 on a full sheet')
console.log('webhook-key-first: all assertions passed')
