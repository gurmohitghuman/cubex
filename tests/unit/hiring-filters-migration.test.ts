// Migration 062 on a database the previous build made (every migration before it applied, as migrate.ts applies
// them) holding a hiring table and a finished check: the upgrade gives the table no filters on Companies (at least
// 1 role, none left out) and the check none kept off, and leaves the rest as it was, so the table answers /api/v1
// and MCP as before (no min_roles, leave_out_companies or companies_kept_off).
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
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql') && f < '062').sort()) {
  const sql = fs.readFileSync(path.join(dir, file), 'utf8')
  const off = sql.startsWith('-- cube:foreign-keys-off')
  if (off) db.pragma('foreign_keys = OFF')
  db.transaction(() => { db.exec(sql); db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file) }).immediate()
  if (off) db.pragma('foreign_keys = ON')
}
const columns = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name)
assert.ok(!columns('hiring_signals').includes('min_roles'))

db.prepare("INSERT INTO users (id, password_hash) VALUES ('u1', 'x')").run()
db.prepare("INSERT INTO tables (id, user_id, name) VALUES ('t1', 'u1', 'Hiring: SDR')").run()
const sheet = db.prepare(`INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?, 't1', 'u1', ?,
  '["Company"]')`)
for (const [id, name] of [['c', 'Companies'], ['r', 'Roles'], ['s', 'Searches']]) sheet.run(id, name)
db.prepare(`INSERT INTO hiring_signals (id, user_id, table_id, companies_sheet_id, roles_sheet_id, searches_sheet_id,
  roles, country) VALUES ('h1', 'u1', 't1', 'c', 'r', 's', '["SDR"]', 'US')`).run()
db.prepare(`INSERT INTO hiring_checks (id, user_id, signal_id, label, stage, roles_added, companies_new)
  VALUES ('k1', 'u1', 'h1', '2026-11-19', 'done', 7, 3)`).run()
const before = db.prepare("SELECT * FROM hiring_signals WHERE id = 'h1'").get() as Record<string, unknown>

runMigrations()
const after = db.prepare("SELECT * FROM hiring_signals WHERE id = 'h1'").get() as Record<string, unknown>
assert.deepEqual(after, { ...before, min_roles: 1, leave_out_companies: '[]' })
const check = db.prepare("SELECT * FROM hiring_checks WHERE id = 'k1'").get() as Record<string, unknown>
assert.deepEqual([check.roles_added, check.companies_new, check.companies_kept_off], [7, 3, 0])

const { hiringFor, hiringView } = await import('../../server/src/services/hiring-store')
const { hiringJson } = await import('../../server/src/services/hiring-agent')
const json = hiringJson(hiringView(hiringFor('u1', 'h1')!)) as Record<string, unknown>
assert.ok(!('min_roles' in json) && !('leave_out_companies' in json), Object.keys(json).join())
assert.ok(!('companies_kept_off' in (json.checks as object[])[0]))

process.stdout.write('All hiring-filters-migration assertions passed.\n')
