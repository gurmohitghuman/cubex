// Migration 060 adds derived_spans and derived_span_marks (lib/derived-spans.ts). On a database the previous build
// made (every migration but 060 applied, 061 too, as migrate.ts applies them) holding a sheet, its rows, a formula's
// auto-run entry and a row queued for it, the upgrade changes none of them and adds the two tables, their indexes
// and the trigger. Then: a span's rowids and run are kept as written; a mark per reader; a reader's deletion takes
// its marks (the cascade) and a span goes with its last mark, whether the mark goes by the cascade or by a DELETE;
// a span keeps going while another reader's mark is left; a span's deletion takes its marks; an account's
// deletion takes its spans and marks. Nothing ties a span to its sheet: the sheet's deletion leaves a span only
// through its readers (their entries go with the sheet, and their marks with them).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
console.log = () => {}

// The database as the previous build (main, with 061) left it: each migration but 060, as migrate.ts runs one.
const dir = path.resolve('server/src/db/migrations')
db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')))`)
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql') && !f.startsWith('060_')).sort()) {
  const sql = fs.readFileSync(path.join(dir, file), 'utf8')
  const off = sql.startsWith('-- cube:foreign-keys-off')
  if (off) db.pragma('foreign_keys = OFF')
  db.transaction(() => { db.exec(sql); db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file) }).immediate()
  if (off) db.pragma('foreign_keys = ON')
}
const tables = () => db.prepare(`SELECT type, name, tbl_name FROM sqlite_master WHERE name LIKE '%span%'
  ORDER BY name`).all()
assert.deepEqual(tables(), [], 'no span table before 060')

for (const u of ['u1', 'u2']) {
  db.prepare("INSERT INTO users (id, password_hash) VALUES (?, 'x')").run(u)
  db.prepare("INSERT INTO tables (id, user_id, name) VALUES (?, ?, 'T')").run(`t-${u}`, u)
  db.prepare(`INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?, ?, ?, 'S',
    '["Answer","F","G"]')`).run(`s-${u}`, `t-${u}`, u)
  const row = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?, ?, ?, ?, ?)')
  for (let i = 0; i < 3; i++) row.run(`${u}-r${i}`, `s-${u}`, u, i, JSON.stringify({ Answer: `a${i}` }))
  for (const c of ['F', 'G']) {
    db.prepare(`INSERT INTO autorun_columns (id, user_id, sheet_id, status_column, kind, input_columns)
      VALUES (?, ?, ?, ?, 'formula', '["Answer"]')`).run(`${u}-${c}`, u, `s-${u}`, c)
  }
  db.prepare('INSERT INTO autorun_pending (autorun_id, user_id, row_id) VALUES (?, ?, ?)')
    .run(`${u}-F`, u, `${u}-r1`)
}
const snapshot = () => ['sheets', 'rows', 'autorun_columns', 'autorun_pending']
  .map(t => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())
const before = snapshot()
const applied = () => db.prepare('SELECT name FROM _migrations ORDER BY name').pluck().all() as string[]
const had = applied()

runMigrations()   // the upgrade: 060 only

assert.deepEqual(snapshot(), before, 'sheets, rows, entries and the queue as they were')
assert.deepEqual(applied().filter(n => !had.includes(n)), ['060_derived_spans.sql'], '060 applied, and no other')
assert.deepEqual(tables(), [
  { type: 'trigger', name: 'derived_span_last_mark', tbl_name: 'derived_span_marks' },
  { type: 'table', name: 'derived_span_marks', tbl_name: 'derived_span_marks' },
  { type: 'table', name: 'derived_spans', tbl_name: 'derived_spans' },
  { type: 'index', name: 'idx_derived_span_marks_span', tbl_name: 'derived_span_marks' },
  { type: 'index', name: 'idx_derived_spans_sheet', tbl_name: 'derived_spans' },
  { type: 'index', name: 'sqlite_autoindex_derived_span_marks_1', tbl_name: 'derived_span_marks' },
])
assert.deepEqual(db.pragma('foreign_key_check'), [])
assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }])

// A span of `rowids` told to `readers` of u's sheet, by an HTTP run.
const span = (u: string, rowids: number[], readers: string[]) => {
  const id = db.prepare(`INSERT INTO derived_spans (user_id, sheet_id, run_kind, run_id, rowids)
    VALUES (?, ?, 'http', 'run-1', ?) RETURNING id`).pluck().get(u, `s-${u}`, JSON.stringify(rowids)) as number
  for (const r of readers) db.prepare('INSERT INTO derived_span_marks (autorun_id, span_id) VALUES (?, ?)').run(r, id)
  return id
}
const spans = () => db.prepare('SELECT id FROM derived_spans ORDER BY id').pluck().all()
const marks = () => db.prepare('SELECT autorun_id, span_id, done FROM derived_span_marks ORDER BY span_id, autorun_id')
  .all()

const a = span('u1', [1, 2, 3], ['u1-F', 'u1-G'])
assert.deepEqual(db.prepare('SELECT user_id, sheet_id, run_kind, run_id, rowids FROM derived_spans WHERE id = ?')
  .get(a), { user_id: 'u1', sheet_id: 's-u1', run_kind: 'http', run_id: 'run-1', rowids: '[1,2,3]' })
assert.deepEqual(marks(), [{ autorun_id: 'u1-F', span_id: a, done: 0 }, { autorun_id: 'u1-G', span_id: a, done: 0 }])
assert.throws(() => db.prepare("INSERT INTO derived_span_marks (autorun_id, span_id) VALUES ('u1-F', ?)").run(a),
  /UNIQUE constraint failed/, 'one mark per reader and span')
assert.throws(() => db.prepare("INSERT INTO derived_span_marks (autorun_id, span_id) VALUES ('none', ?)").run(a),
  /FOREIGN KEY constraint failed/, 'a mark is a reader\'s')
assert.throws(() => db.prepare(`INSERT INTO derived_spans (user_id, sheet_id, run_kind, rowids)
  VALUES ('u1', 's-u1', 'list', '[]')`).run(), /CHECK constraint failed/)

// A reader deleted: its mark goes, the span stays for the other; that one's DELETE takes the span.
db.prepare("DELETE FROM autorun_columns WHERE id = 'u1-F'").run()
assert.deepEqual([spans(), marks()], [[a], [{ autorun_id: 'u1-G', span_id: a, done: 0 }]])
db.prepare("DELETE FROM derived_span_marks WHERE autorun_id = 'u1-G'").run()
assert.deepEqual([spans(), marks()], [[], []], 'a span goes with its last mark')

// The last mark going by the cascade takes its span too; a span's deletion takes its marks.
const b = span('u1', [4], ['u1-G'])
const c = span('u1', [5], ['u1-G'])
db.prepare('DELETE FROM derived_spans WHERE id = ?').run(c)
assert.deepEqual([spans(), marks()], [[b], [{ autorun_id: 'u1-G', span_id: b, done: 0 }]])
db.prepare("DELETE FROM autorun_columns WHERE id = 'u1-G'").run()
assert.deepEqual(spans(), [], 'the cascade\'s delete fires the trigger')

// The sheet's deletion takes its entries, their marks and so the spans; an account's takes its spans.
span('u1', [6], [])
const d = span('u2', [7], ['u2-F', 'u2-G'])
db.prepare("DELETE FROM sheets WHERE id = 's-u2'").run()
assert.deepEqual(db.prepare('SELECT sheet_id FROM derived_spans').pluck().all(), ['s-u1'], 'u2\'s span went')
assert.ok(d > 0)
db.prepare("DELETE FROM users WHERE id = 'u1'").run()
assert.deepEqual([spans(), marks()], [[], []], 'an account\'s spans go with it')
assert.deepEqual(db.pragma('foreign_key_check'), [])
console.error('All derived-spans-migration assertions passed.')
