// Migration 002 rebuilds the rows table (one UNIQUE(sheet_id, user_id,
// row_index) instead of UNIQUE(sheet_id, row_index) + two plain indexes). It
// runs once on real data, so pin it on a database built at the 001 schema: every
// row keeps its id, rowid, position and data; a webhook delivery still points at
// its row (dropping the old table with foreign keys on would have nulled it);
// the new key rejects a duplicate position; deleting a sheet still cascades to
// its rows; and foreign keys are back on afterwards.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import { v4 as uuid } from 'uuid'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

// Bring the database to exactly the 001 schema, as an existing install has it.
db.exec(fs.readFileSync(fileURLToPath(new URL('../../server/src/db/migrations/001_schema.sql', import.meta.url)), 'utf8'))
db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))")
db.prepare('INSERT INTO _migrations (name) VALUES (?)').run('001_schema.sql')

const uid = uuid(), tid = uuid(), sid = uuid(), sid2 = uuid(), src = uuid()
db.prepare('INSERT INTO users (id, password_hash) VALUES (?, ?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?, ?, ?)').run(tid, uid, 'T')
for (const [id, name] of [[sid, 'S1'], [sid2, 'S2']]) {
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, position) VALUES (?, ?, ?, ?, 0)').run(id, tid, uid, name)
}
const ins = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)')
for (let i = 0; i < 50; i++) ins.run(uuid(), i % 2 ? sid : sid2, uid, Math.floor(i / 2), JSON.stringify({ n: String(i) }))
const linkedRow = (db.prepare('SELECT id FROM rows WHERE sheet_id = ? AND row_index = 7').get(sid) as { id: string }).id
db.prepare(`INSERT INTO webhook_sources (id, user_id, sheet_id, token_hash, raw_column_name) VALUES (?, ?, ?, ?, 'Webhook')`)
  .run(src, uid, sid, 'hash')
db.prepare(`INSERT INTO webhook_deliveries (id, source_id, user_id, sheet_id, row_id, payload, payload_sha256, payload_bytes, status)
  VALUES (?, ?, ?, ?, ?, '{}', 'h', 2, 'stored')`).run(uuid(), src, uid, sid, linkedRow)
const snapshot = () => db.prepare('SELECT rowid, id, sheet_id, user_id, row_index, data, updated_at FROM rows ORDER BY rowid').all()
const before = snapshot()

runMigrations()

let failures = 0
const ok = (label: string, fn: () => void) => {
  try { fn(); console.log('ok  ', label) } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).message) }
}
ok('every row kept: rowid, id, sheet, position, data, updated_at', () => assert.deepEqual(snapshot(), before))
ok('the webhook delivery still points at its row', () => assert.equal(
  (db.prepare('SELECT row_id FROM webhook_deliveries').get() as { row_id: string | null }).row_id, linkedRow))
ok('one unique index on (sheet_id, user_id, row_index), the old indexes gone', () => {
  const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'rows'").all() as Array<{ name: string; sql: string | null }>
  assert.deepEqual(idx.map(i => i.name).sort(), ['sqlite_autoindex_rows_1', 'sqlite_autoindex_rows_2'])
  const cols = (name: string) => (db.prepare(`PRAGMA index_info('${name}')`).all() as Array<{ name: string }>).map(c => c.name)
  assert.deepEqual(cols('sqlite_autoindex_rows_2'), ['sheet_id', 'user_id', 'row_index'])
})
ok('a duplicate position is rejected', () => assert.throws(
  () => ins.run(uuid(), sid, uid, 7, '{}'), /UNIQUE constraint failed: rows.sheet_id, rows.user_id, rows.row_index/))
ok('the same position in another sheet is fine', () => { ins.run(uuid(), sid, uid, 999, '{}'); ins.run(uuid(), sid2, uid, 999, '{}') })
ok('foreign keys are on again, and deleting a sheet cascades to its rows', () => {
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
  db.prepare('DELETE FROM sheets WHERE id = ?').run(sid2)
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM rows WHERE sheet_id = ?').get(sid2) as { c: number }).c, 0)
})
ok('the planner pages and counts from the new index', () => {
  const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(sid, uid) as Array<{ detail: string }>).map(r => r.detail).join(' | ')
  assert.match(plan('SELECT * FROM rows WHERE sheet_id = ? AND user_id = ? ORDER BY row_index LIMIT 200 OFFSET 100'), /sqlite_autoindex_rows_2/)
  assert.match(plan('SELECT COUNT(*) FROM rows WHERE sheet_id = ? AND user_id = ?'), /COVERING INDEX sqlite_autoindex_rows_2/)
})

if (failures > 0) { console.error(`\n${failures} assertion(s) failed.`); process.exit(1) }
console.log('\nAll rows-rebuild-migration assertions passed.')
