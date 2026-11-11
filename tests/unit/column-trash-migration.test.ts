// Migration 054 rebuilds trash_items (its kinds now take 'column'). On a database the previous build made
// (every migration before 054 applied, as migrate.ts applies them) holding trash items of every kind, rows in
// them, items purged since (so the AUTOINCREMENT sequence is past every id left) and a strip under way, the
// upgrade keeps every item with its id and every field, the sequence, the three indexes and the rows; a new
// item takes the next id after the sequence, never an old one; a strip left keeps going with no trash item.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
console.log = () => {}

// The database as the previous build left it: each migration before 054, as migrate.ts runs one.
const dir = path.resolve('server/src/db/migrations')
db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))')
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql') && f < '054').sort()) {
  const sql = fs.readFileSync(path.join(dir, file), 'utf8')
  const off = sql.startsWith('-- cube:foreign-keys-off')
  if (off) db.pragma('foreign_keys = OFF')
  db.transaction(() => { db.exec(sql); db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file) })()
  if (off) db.pragma('foreign_keys = ON')
}
assert.equal(db.prepare("SELECT COUNT(*) FROM _migrations WHERE name LIKE '054%'").pluck().get(), 0)

db.prepare("INSERT INTO users (id, password_hash) VALUES ('u1', 'x')").run()
const add = db.prepare(`INSERT INTO trash_items (user_id, kind, table_id, sheet_id, table_name, sheet_name, how, via,
  token_name, row_count, bytes, columns, row_generation, top_index, state, restore_at, restored, deleted_at, seq_high)
  VALUES ('u1', ?, 't1', ?, 'Leads', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
add.run('rows', 's1', 'Sheet 1', 'grid', 'app', null, 2, 40, '["Email","Name"]', 3, 8, 'kept', null, 0,
  '2026-11-01 10:00:00', 2)
add.run('sheet', 's2', 'Sheet 2', 'sheet', 'mcp', 'agent', 500, 0, '[]', null, null, 'kept', null, 0,
  '2026-11-02 11:00:00', 0)
add.run('rows', 's1', 'Sheet 1', 'auto_dedupe', 'cubex', null, 1, 10, '["Email"]', 3, 4, 'restoring', 40, 1,
  '2026-11-03 12:00:00', 5)
add.run('table', null, null, 'table', 'api', 'ci', 900, 0, '[]', null, null, 'purging', null, 0,
  '2026-11-04 13:00:00', 0)
for (let i = 0; i < 3; i++) add.run('rows', 's1', 'Sheet 1', 'api', 'api', 'ci', 0, 0, '[]', 1, 0, 'kept', null, 0,
  '2026-11-05 14:00:00', 0)
db.prepare('DELETE FROM trash_items WHERE id >= 6').run()   // purged: the sequence stays at 7
const rows = db.prepare('INSERT INTO trash_rows (item_id, seq, row_index, row_id, data) VALUES (?, ?, ?, ?, ?)')
rows.run(1, 1, 2, 'r2', '{"Email":"a@x.co","Name":"A"}')
rows.run(1, 2, 8, 'r8', '{"Email":"b@x.co","Name":"B"}')
rows.run(3, 5, 3, 'r3', '{"Email":"c@x.co"}')
db.prepare("INSERT INTO tables (id, user_id, name) VALUES ('t1', 'u1', 'Leads')").run()
db.prepare(`INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES ('s1', 't1', 'u1', 'Sheet 1',
  '["Email"]')`).run()
db.prepare("INSERT INTO column_purges (sheet_id, user_id, column_name) VALUES ('s1', 'u1', 'Old')").run()

const items = () => db.prepare('SELECT * FROM trash_items ORDER BY id').all() as Array<Record<string, unknown>>
const indexes = () => db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'trash_items'
  ORDER BY name`).all()
const before = items()
const beforeIndexes = indexes()
const beforeRows = db.prepare('SELECT * FROM trash_rows ORDER BY item_id, seq').all()
assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'trash_items'").pluck().get(), 7)

runMigrations()   // the upgrade: 054 only

const after = items()
const NEW = { column_name: null, column_position: null, column_setup: null, column_dropped: null, restore_name: null,
  restore_skipped: 0, restore_kept: 0, restore_keys: 0, restore_cursor: 0, restore_into: 0 }
assert.deepEqual(after, before.map(i => ({ ...i, ...NEW })), 'every item, its id and every field')
assert.deepEqual(after.map(i => i.id), [1, 2, 3, 4, 5])
assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'trash_items'").pluck().get(), 7)
assert.equal(db.prepare("SELECT COUNT(*) FROM sqlite_sequence WHERE name LIKE 'trash_items%'").pluck().get(), 1)
assert.deepEqual(indexes(), beforeIndexes, 'the same three indexes')
assert.equal(beforeIndexes.length, 3)
assert.deepEqual(db.prepare('SELECT * FROM trash_rows ORDER BY item_id, seq').all(), beforeRows)
assert.deepEqual(db.prepare('SELECT column_name, trash_id FROM column_purges').all(), [{ column_name: 'Old',
  trash_id: null }])
assert.deepEqual(db.pragma('foreign_key_check'), [])
assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }])
const next = db.prepare(`INSERT INTO trash_items (user_id, kind, table_id, sheet_id, table_name, how, via, column_name)
  VALUES ('u1', 'column', 't1', 's1', 'Leads', 'column', 'app', 'Notes')`).run()
assert.equal(next.lastInsertRowid, 8, 'never an id an item had')
assert.throws(() => db.prepare(`INSERT INTO trash_items (user_id, kind, table_id, table_name, how, via)
  VALUES ('u1', 'cell', 't1', 'Leads', 'x', 'app')`).run(), /CHECK constraint failed/)
// The users foreign key is still there: an account's items go with it.
db.prepare("DELETE FROM users WHERE id = 'u1'").run()
assert.equal(db.prepare('SELECT COUNT(*) FROM trash_items').pluck().get(), 0)
console.error('All column-trash-migration assertions passed.')
