// Duplicate keys after the company and person name cleaners changed
// (lib/dedupe/key.ts reads names through them). Remove duplicates works its
// keys out on every check; auto-dedupe keeps one per row (auto_dedupe_keys),
// so migration 053 has settings matching on company or person_name build
// theirs again. Pins: a placeholder has no key (never a duplicate, never
// matching another placeholder); a name with an emoji or in full-width
// letters matches the plain one; on a database at migration 052 whose keys
// the old cleaners built, 053 sends those settings (only those) back to
// building with shared_rows cleared (null, as a new setting's, while they
// build), the build rewrites the keys in place, removes nothing and counts
// shared_rows again, and a new row holding a value whose old key differed is
// then caught.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import dedupeKeyMod from '../../server/src/lib/dedupe/key'
import keyMod from '../../server/src/lib/auto-dedupe/key'
import storeMod from '../../server/src/lib/auto-dedupe/store'
import settingMod from '../../server/src/services/auto-dedupe-setting'
import indexMod from '../../server/src/services/auto-dedupe-index'
import rowsMod from '../../server/src/services/rows-write'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { keyPart, rowKey } = dedupeKeyMod as typeof import('../../server/src/lib/dedupe/key')
const { autoDedupeKey } = keyMod as typeof import('../../server/src/lib/auto-dedupe/key')
const { autoDedupeOf, storedKey } = storeMod as typeof import('../../server/src/lib/auto-dedupe/store')
const { setAutoDedupe, autoDedupeView } = settingMod as typeof import('../../server/src/services/auto-dedupe-setting')
const { maintainAutoDedupeSheet } = indexMod as typeof import('../../server/src/services/auto-dedupe-index')
const { appendRows } = rowsMod as typeof import('../../server/src/services/rows-write')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
console.warn = () => {}

let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const company = { match: 'company' as const, phone_country: null }
const person = { match: 'person_name' as const, phone_country: null }

await ok('a placeholder has no key: never a duplicate, never matching another placeholder', () => {
  for (const v of ['n/a', 'N/A', 'none', 'unknown', 'test', '-', '(null)']) {
    assert.equal(keyPart({ column: 'C', match: 'company' }, v), '', v)
    assert.equal(rowKey([keyPart({ column: 'C', match: 'company' }, v)]), null, v)
    assert.equal(autoDedupeKey(company, v), null, v)
    assert.equal(autoDedupeKey(person, v), null, v)
  }
  // With a second key column a placeholder still makes the row no duplicate.
  assert.equal(rowKey(['jo@acme.com', keyPart({ column: 'N', match: 'person_name' }, 'Unknown')]), null)
  // "Na" is a name.
  assert.equal(autoDedupeKey(person, 'Na'), '=na')
})

await ok('an emoji or full-width letters match the plain name', () => {
  assert.equal(autoDedupeKey(company, 'Docsumo 📄'), autoDedupeKey(company, 'Docsumo'))
  assert.equal(autoDedupeKey(company, 'ＡＣＭＥ ＩＮＣ'), autoDedupeKey(company, 'Acme'))
  assert.equal(autoDedupeKey(person, 'Katie Siklitska 🇺🇦'), autoDedupeKey(person, 'katie siklitska'))
  assert.equal(autoDedupeKey(person, 'Ｍｉｃｈａｅｌ Smith'), autoDedupeKey(person, 'Michael Smith'))
  // Jr and Sr still tell a father and son apart.
  assert.notEqual(autoDedupeKey(person, 'John Smith Jr. 👋'), autoDedupeKey(person, 'John Smith'))
})

// A database at migration 052, as an install has it before this change.
const dir = fileURLToPath(new URL('../../server/src/db/migrations/', import.meta.url))
db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))")
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql') && f < '053').sort()) {
  db.exec(fs.readFileSync(dir + f, 'utf8'))
  db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f)
}

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
function sheet(name: string, values: string[]): string {
  const id = uuid()
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
    .run(id, tid, uid, name, JSON.stringify(['C']))
  const ins = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
  values.forEach((v, i) => ins.run(uuid(), id, uid, i, JSON.stringify({ C: v })))
  return id
}
const rids = (s: string) => db.prepare('SELECT rowid FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
  .all(s) as number[]
const values = (s: string) => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
  .all(s) as string[]).map(d => JSON.parse(d).C)
async function turnOn(s: string, match: 'company' | 'text') {
  const out = setAutoDedupe(uid, s, { column: 'C', match, keep: 'oldest' })
  assert.ok('ok' in out, JSON.stringify(out))
  assert.equal(await maintainAutoDedupeSheet(s, uid, Date.now() + 10_000), 'ready')
}

const OLD = ['Docsumo 📄', 'Acme', 'n/a', 'n/a', 'Docsumo']
const S = sheet('S', OLD)
const T = sheet('T', ['n/a', 'b'])
await turnOn(S, 'company')
await turnOn(T, 'text')
// The keys the cleaner before this change built (it kept the emoji and read
// "n/a" as a name), written as that version left them.
const putKey = db.prepare(`INSERT INTO auto_dedupe_keys (dedupe_id, rid, key) VALUES (?, ?, ?)
  ON CONFLICT(dedupe_id, rid) DO UPDATE SET key = excluded.key`)
const sId = autoDedupeOf(S, uid)!.id
const [docsumoEmoji, , na1, na2] = rids(S)
putKey.run(sId, docsumoEmoji, '=docsumo 📄')
putKey.run(sId, na1, '=n/a')
putKey.run(sId, na2, '=n/a')
const textKeys = db.prepare('SELECT rid, key FROM auto_dedupe_keys WHERE dedupe_id = ? ORDER BY rid').all(
  autoDedupeOf(T, uid)!.id)
const textShared = autoDedupeOf(T, uid)!.shared_rows
await ok('before 053: the old count shows (the two "n/a" rows shared a key)', () => {
  assert.equal(autoDedupeOf(S, uid)!.shared_rows, 1)
})

runMigrations()

await ok('053 sends company and person_name settings back to building, and only those', () => {
  assert.equal(autoDedupeOf(S, uid)!.build_cursor, 0)
  assert.equal(autoDedupeView(S, uid)!.state, 'building')
  assert.equal(autoDedupeOf(S, uid)!.shared_rows, null)
  assert.equal(autoDedupeView(S, uid)!.shared_rows, null)
  assert.equal(autoDedupeOf(T, uid)!.build_cursor, null)
  assert.equal(autoDedupeOf(T, uid)!.shared_rows, textShared)
  assert.deepEqual(db.prepare('SELECT rid, key FROM auto_dedupe_keys WHERE dedupe_id = ? ORDER BY rid').all(
    autoDedupeOf(T, uid)!.id), textKeys)
})

await ok('the build rewrites the keys in place and removes nothing', async () => {
  assert.equal(await maintainAutoDedupeSheet(S, uid, Date.now() + 10_000), 'ready')
  const s = autoDedupeOf(S, uid)!
  assert.equal(s.id, sId)
  assert.equal(s.build_cursor, null)
  assert.equal(storedKey(sId, docsumoEmoji), '=docsumo')
  assert.equal(storedKey(sId, na1), null)
  assert.equal(storedKey(sId, na2), null)
  // "Docsumo 📄" and "Docsumo" share a key now; the two "n/a" rows don't.
  assert.equal(s.shared_rows, 1)
  assert.deepEqual(values(S), OLD)
})

await ok('a new row whose old key differed is caught; a placeholder row is kept', () => {
  const out = appendRows(S, uid, [{ C: 'DOCSUMO 📄' }, { C: 'n/a' }, { C: 'Globex' }])
  assert.ok('ok' in out, JSON.stringify(out))
  assert.equal(out.ok.kept, 2)
  assert.deepEqual([...out.ok.notKept], [out.ok.rows[0].id])
  assert.deepEqual(values(S), [...OLD, 'n/a', 'Globex'])
})

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall dedupe-name-keys checks passed')
process.exit(0)
