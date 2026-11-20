// Migration 061 on a database the previous build made (every migration before it applied, as migrate.ts applies
// them) holding a table, sheets and rows: the upgrade adds enrichment_list_seen, hiring_signals and hiring_checks
// and leaves what was there; one check of a table can go at a time (the partial unique index), a stage is one of
// four; deleting the Companies sheet deletes the table's record and its checks, deleting Roles or Searches keeps
// the record with no link to them, and deleting a sheet forgets what its keep-mode runs saw.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
console.log = () => {}

const dir = path.resolve('server/src/db/migrations')
db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')))`)
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql') && f < '061').sort()) {
  const sql = fs.readFileSync(path.join(dir, file), 'utf8')
  const off = sql.startsWith('-- cube:foreign-keys-off')
  if (off) db.pragma('foreign_keys = OFF')
  db.transaction(() => { db.exec(sql); db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file) }).immediate()
  if (off) db.pragma('foreign_keys = ON')
}
const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)
assert.ok(!has('hiring_signals') && !has('enrichment_list_seen'))

db.prepare("INSERT INTO users (id, password_hash) VALUES ('u1', 'x')").run()
db.prepare("INSERT INTO tables (id, user_id, name) VALUES ('t1', 'u1', 'Hiring: SDR')").run()
const sheet = db.prepare(`INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?, 't1', 'u1', ?,
  '["Company"]')`)
for (const [id, name] of [['c', 'Companies'], ['r', 'Roles'], ['s', 'Searches']]) sheet.run(id, name)
db.prepare(`INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES ('row1', 'c', 'u1', 0,
  '{"Company":"Acme"}')`).run()

runMigrations()
assert.ok(has('hiring_signals') && has('hiring_checks') && has('enrichment_list_seen'))
assert.equal(db.prepare("SELECT data FROM rows WHERE id = 'row1'").pluck().get(), '{"Company":"Acme"}')

db.prepare(`INSERT INTO hiring_signals (id, user_id, table_id, companies_sheet_id, roles_sheet_id, searches_sheet_id,
  roles) VALUES ('h1', 'u1', 't1', 'c', 'r', 's', '["SDR"]')`).run()
const check = db.prepare(`INSERT INTO hiring_checks (id, user_id, signal_id, label, stage)
  VALUES (?, 'u1', 'h1', '2026-11-19', ?)`)
check.run('k1', 'searching')
assert.throws(() => check.run('k2', 'summarizing'), /UNIQUE/, 'a second going check')
check.run('k3', 'done')
check.run('k4', 'stopped')
assert.throws(() => check.run('k5', 'waiting'), /CHECK/, 'a stage not one of four')
db.prepare("UPDATE hiring_checks SET stage = 'done' WHERE id = 'k1'").run()
check.run('k6', 'searching')

const seen = db.prepare(`INSERT INTO enrichment_list_seen (dest_sheet_id, dedupe_key, user_id) VALUES (?, ?, 'u1')`)
seen.run('r', 'k1')
assert.throws(() => seen.run('r', 'k1'), /UNIQUE|PRIMARY/, 'a key once per sheet')
seen.run('c', 'k1')

db.prepare("DELETE FROM sheets WHERE id = 'r'").run()
assert.equal(db.prepare("SELECT roles_sheet_id FROM hiring_signals WHERE id = 'h1'").pluck().get(), null)
assert.equal(db.prepare("SELECT COUNT(*) FROM enrichment_list_seen WHERE dest_sheet_id = 'r'").pluck().get(), 0)
db.prepare("DELETE FROM sheets WHERE id = 's'").run()
assert.equal(db.prepare("SELECT searches_sheet_id FROM hiring_signals WHERE id = 'h1'").pluck().get(), null)
db.prepare("DELETE FROM sheets WHERE id = 'c'").run()
assert.equal(db.prepare('SELECT COUNT(*) FROM hiring_signals').pluck().get(), 0)
assert.equal(db.prepare('SELECT COUNT(*) FROM hiring_checks').pluck().get(), 0)
assert.equal(db.prepare('SELECT COUNT(*) FROM enrichment_list_seen').pluck().get(), 0)

process.stdout.write('All hiring-migration assertions passed.\n')
