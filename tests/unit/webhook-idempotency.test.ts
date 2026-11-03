// Webhook deliveries a sender retries add their row once (migration 049,
// lib/webhook-idempotency.ts): the same Idempotency-Key with the same body
// within a day adds nothing; with another body it's a new event; after a day
// the key is forgotten, and the sweep deletes it. "Add again"
// (services/webhook-replay.ts) reads a logged delivery with the mappings as they
// are now, as a new row that names the one it repeats, without counting as an
// arrival, and says when auto-dedupe replaced a row for it.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import ingestMod from '../../server/src/lib/webhook-ingest'
import idemMod from '../../server/src/lib/webhook-idempotency'
import replayMod from '../../server/src/services/webhook-replay'
import settingMod from '../../server/src/services/auto-dedupe-setting'
import indexMod from '../../server/src/services/auto-dedupe-index'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { appendWebhookDelivery } = ingestMod as typeof import('../../server/src/lib/webhook-ingest')
const { parseIdempotencyKey, pruneWebhookKeys } = idemMod as typeof import('../../server/src/lib/webhook-idempotency')
const { replayDelivery } = replayMod as typeof import('../../server/src/services/webhook-replay')
const { setAutoDedupe } = settingMod as typeof import('../../server/src/services/auto-dedupe-setting')
const { maintainAutoDedupeSheet } = indexMod as typeof import('../../server/src/services/auto-dedupe-index')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid(), tid = uuid(), sid = uuid(), src = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
  .run(sid, tid, uid, 'Leads', JSON.stringify(['Webhook', 'Email']))
db.prepare(`INSERT INTO webhook_sources (id, user_id, sheet_id, token_hash, raw_column_name)
  VALUES (?,?,?,?,?)`).run(src, uid, sid, 'hash-1', 'Webhook')
const mapping = uuid()
db.prepare(`INSERT INTO webhook_mappings (id, source_id, user_id, json_path, column_name) VALUES (?,?,?,?,?)`)
  .run(mapping, src, uid, '$.mail', 'Email')

const source = () => db.prepare('SELECT * FROM webhook_sources WHERE id = ?').get(src) as
  Parameters<typeof appendWebhookDelivery>[0]
const mappings = () => db.prepare('SELECT json_path, column_name, value_mode FROM webhook_mappings WHERE source_id = ?')
  .all(src) as Parameters<typeof appendWebhookDelivery>[1]
const send = (body: Record<string, unknown>, key?: string) =>
  appendWebhookDelivery(source(), mappings(), body, JSON.stringify(body), { idempotencyKey: key ?? null })
const rows = () => db.prepare('SELECT count(*) FROM rows WHERE sheet_id = ?').pluck().get(sid) as number
const deliveries = () => db.prepare('SELECT count(*) FROM webhook_deliveries WHERE source_id = ?')
  .pluck().get(src) as number
const keys = () => db.prepare('SELECT count(*) FROM webhook_idempotency WHERE source_id = ?').pluck().get(src) as number
const received = () => db.prepare('SELECT total_received FROM webhook_sources WHERE id = ?').pluck().get(src) as number
const emails = () => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sid) as
  string[]).map(d => JSON.parse(d).Email ?? '')

// The header.
check('no key', JSON.stringify(parseIdempotencyKey(undefined)) === '{"key":null}'
  && JSON.stringify(parseIdempotencyKey('')) === '{"key":null}')
check('a key, trimmed', JSON.stringify(parseIdempotencyKey(' evt_123-ABC:9 ')) === '{"key":"evt_123-ABC:9"}')
check('spaces inside, control characters, non-ASCII and over 255 characters are refused',
  ['a b', 'a\u0001b', 'café', 'x'.repeat(256)].every(k => 'error' in parseIdempotencyKey(k)))

// Retries.
const first = send({ mail: 'a@x.com' }, 'order-1')
check('a delivery with a key adds its row', first.ok && first.status === 'stored' && rows() === 1, first)
const again = send({ mail: 'a@x.com' }, 'order-1')
check('the same key and body again adds nothing, logs nothing, counts nothing',
  again.ok && again.status === 'repeat' && rows() === 1 && deliveries() === 1 && received() === 1, again)
const other = send({ mail: 'b@x.com' }, 'order-1')
check('the same key with another body is a new event: added (no one can block a real event with a key)',
  other.ok && other.status === 'stored' && rows() === 2, other)
check('... and the key still stops its first body\'s retries', send({ mail: 'a@x.com' }, 'order-1').ok && rows() === 2)
send({ mail: 'c@x.com' }, 'order-2')
send({ mail: 'd@x.com' })
send({ mail: 'd@x.com' })
check('another key, and deliveries without one, each add a row', rows() === 5 && received() === 5)
db.prepare("UPDATE webhook_idempotency SET created_at = datetime('now', '-25 hours') WHERE key = 'order-1'").run()
const later = send({ mail: 'a@x.com' }, 'order-1')
check('a key over a day old is forgotten: the delivery adds a row again, and the key starts over',
  later.ok && later.status === 'stored' && rows() === 6 && keys() === 2
  && db.prepare("SELECT created_at > datetime('now', '-1 hour') FROM webhook_idempotency WHERE key = 'order-1'")
    .pluck().get() === 1, later)
db.prepare("UPDATE webhook_idempotency SET created_at = datetime('now', '-25 hours') WHERE key = 'order-2'").run()
pruneWebhookKeys()
check('the sweep deletes keys over a day old, and only those', keys() === 1)

// Add again, after fixing the mapping.
db.prepare("UPDATE webhook_mappings SET json_path = '$.email' WHERE id = ?").run(mapping)
const d = db.prepare(`SELECT id FROM webhook_deliveries WHERE source_id = ? ORDER BY received_at, rowid LIMIT 1`)
  .pluck().get(src) as string
send({ email: 'fixed@x.com' }) // a new arrival maps with the fixed path
const before = { rows: rows(), received: received() }
const replayed = replayDelivery(uid, sid, d)
check('a delivery added again is read with the mappings as they are now (its field now unmapped)',
  'ok' in replayed && rows() === before.rows + 1 && emails().at(-1) === '' && emails().at(-2) === 'fixed@x.com',
  { replayed, emails: emails() })
const newest = db.prepare(`SELECT replay_of FROM webhook_deliveries WHERE source_id = ? ORDER BY rowid DESC LIMIT 1`)
  .pluck().get(src)
check('its delivery names the one it repeats; it isn\'t counted as an arrival',
  newest === d && received() === before.received)
check('History says it was added again', !!db.prepare(`SELECT 1 FROM sheet_changes WHERE sheet_id = ?
  AND action = 'webhook' AND summary LIKE 'Added a webhook delivery from % again'`).get(sid))
db.prepare("UPDATE webhook_deliveries SET payload = '', payload_bytes = 0, status = 'pruned' WHERE id = ?").run(d)
const gone = replayDelivery(uid, sid, d)
check('a delivery whose payload is no longer kept can\'t be added again',
  'fail' in gone && gone.fail === 'conflict' && rows() === before.rows + 1, gone)
const elsewhere = replayDelivery(uuid(), sid, d)
check('another account\'s sheet: not found', 'fail' in elsewhere && elsewhere.fail === 'not_found')

// With auto-dedupe keeping the newest row, a delivery added again replaces its earlier row, and says so.
db.prepare("UPDATE webhook_mappings SET json_path = '$.mail' WHERE id = ?").run(mapping)
const original = send({ mail: 'zed@x.com' })
check('(an event in)', original.ok && original.status === 'stored')
const turnedOn = setAutoDedupe(uid, sid, { column: 'Email', match: 'email', keep: 'newest' })
check('(auto-dedupe on, keeping the newest)', 'ok' in turnedOn, turnedOn)
await maintainAutoDedupeSheet(sid, uid, Date.now() + 10_000)
const zed = db.prepare(`SELECT id FROM webhook_deliveries WHERE source_id = ? ORDER BY rowid DESC LIMIT 1`)
  .pluck().get(src) as string
const newer = replayDelivery(uid, sid, zed)
check('added again, it replaces the earlier row with its key, and the answer counts it',
  'ok' in newer && newer.ok.status === 'stored' && newer.ok.replaced === 1
  && emails().filter(e => e === 'zed@x.com').length === 1, { newer, emails: emails() })
check('History says so', !!db.prepare(`SELECT 1 FROM sheet_changes WHERE sheet_id = ? AND action = 'webhook'
  AND summary LIKE '%again: it replaced 1 row with the same key (auto-dedupe)'`).get(sid))

// Deleting the webhook forgets its keys.
db.prepare('DELETE FROM webhook_sources WHERE id = ?').run(src)
check('keys go with their webhook', db.prepare('SELECT count(*) FROM webhook_idempotency').pluck().get() === 0)

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
