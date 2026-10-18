// Descriptions on a migrated throwaway DB: the text is cleaned like a name
// (hidden and bidi characters go, line breaks stay), a column's follows its
// rename, goes with its delete and with a CSV replace that drops the column, a
// stale one under a new name never blocks a rename, and a sheet's is kept on
// the sheet (and moves the tab list key, so open tabs refresh).
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import textMod from '../../server/src/lib/description-text'
import storeMod from '../../server/src/lib/column-descriptions'
import descMod from '../../server/src/services/descriptions'
import keyMod from '../../server/src/lib/sheet-list-key'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { cleanDescription } = textMod as typeof import('../../server/src/lib/description-text')
const { sheetColumnDescriptions, forgetUnlistedColumnDescriptions } =
  storeMod as typeof import('../../server/src/lib/column-descriptions')
const { describeColumn, describeSheet, descriptionProblem } =
  descMod as typeof import('../../server/src/services/descriptions')
const { sheetListKey } = keyMod as typeof import('../../server/src/lib/sheet-list-key')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log('ok  ', label)
  } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

runMigrations()
const { deleteSheetColumn } = await import('../../server/src/services/column-delete')
const { renameSheetColumn } = await import('../../server/src/services/column-rename')
const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'Leads', JSON.stringify(['Name', 'Email', 'Phone']))
db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,0,?)')
  .run(uuid(), sid, uid, JSON.stringify({ Name: 'Ada', Email: 'ada@x.io', Phone: '1' }))
const described = () => Object.fromEntries(sheetColumnDescriptions(sid, uid))

await check('text: hidden, bidi and control characters go; line breaks stay, one blank line at most', () => {
  const [rlo, zwsp, zwj] = [0x202E, 0x200B, 0x200D].map(c => String.fromCodePoint(c))
  const tag = String.fromCodePoint(0xE0069, 0xE0067)
  const out = cleanDescription(`  Work ${rlo}email${tag}${zwsp} only\r\n\r\n\r\n\r\nNever\u0007 personal \t `, 100)
  assert.deepEqual(out, { text: 'Work email only\n\nNever personal' })
  assert.deepEqual(cleanDescription('   ', 100), { text: null })
  assert.deepEqual(cleanDescription(null, 100), { text: null })
  assert.ok('error' in cleanDescription(42, 100))
  assert.ok('error' in cleanDescription('x'.repeat(101), 100))
  assert.ok('error' in cleanDescription('x'.repeat(401), 100))   // refused before cleaning
  assert.deepEqual(cleanDescription(` ${zwsp.repeat(300)}ok`, 100), { text: 'ok' })
  const coder = `👩${zwj}💻 ok`
  assert.deepEqual(cleanDescription(coder, 100), { text: coder })
  assert.equal(descriptionProblem('x'.repeat(1001), 'column')?.includes('1,000'), true)
  assert.equal(descriptionProblem('x'.repeat(1001), 'sheet'), null)
})

await check('a column must be the sheet\'s; empty clears it', () => {
  const missing = describeColumn(sid, uid, 'Nope', 'x')
  assert.ok('fail' in missing && missing.fail === 'not_found')
  assert.ok('ok' in describeColumn(sid, uid, 'Email', 'Work email, checked'))
  assert.deepEqual(described(), { Email: 'Work email, checked' })
  assert.ok('ok' in describeColumn(sid, uid, 'Email', ''))
  assert.deepEqual(described(), {})
  assert.ok('ok' in describeColumn(sid, uid, 'Email', 'Work email, checked'))
})

await check('a rename carries it, and a stale record under the new name never blocks the rename', async () => {
  db.prepare(`INSERT INTO column_descriptions (id,user_id,sheet_id,column_name,description)
    VALUES (?,?,?,'Mail','left over')`).run(uuid(), uid, sid)
  assert.ok('ok' in await renameSheetColumn(sid, uid, 'Email', 'Mail'))
  assert.deepEqual(described(), { Mail: 'Work email, checked' })
})

await check('a delete takes it', async () => {
  assert.ok('ok' in describeColumn(sid, uid, 'Phone', 'Mobile first'))
  assert.ok('ok' in await deleteSheetColumn(sid, uid, 'Phone'))
  assert.deepEqual(described(), { Mail: 'Work email, checked' })
})

await check('a CSV replace that drops the column forgets it', () => {
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(['Name']), sid)
  forgetUnlistedColumnDescriptions(sid, uid)
  assert.deepEqual(described(), {})
})

await check('a sheet\'s description: saved, cleared, moves the tab list key, bumps data_version', () => {
  const before = sheetListKey(tid, uid)
  const dv = () => (db.prepare('SELECT data_version FROM sheets WHERE id = ?').get(sid) as { data_version: number })
    .data_version
  const v0 = dv()
  assert.deepEqual(describeSheet(sid, uid, 'Inbound leads from the site form'),
    { ok: { description: 'Inbound leads from the site form' } })
  assert.equal(dv(), v0 + 1)
  assert.notEqual(sheetListKey(tid, uid), before)
  assert.ok('ok' in describeSheet(sid, uid, ''))
  assert.equal(dv(), v0 + 2)
  assert.ok('ok' in describeColumn(sid, uid, 'Name', 'x'))
  assert.equal(dv(), v0 + 3)
  assert.ok('ok' in describeColumn(sid, uid, 'Name', ''))
  assert.equal((db.prepare('SELECT description FROM sheets WHERE id = ?').get(sid) as { description: null })
    .description, null)
  const gone = describeSheet(uuid(), uid, 'x')
  assert.ok('fail' in gone && gone.fail === 'not_found')
})

await check('deleting the sheet deletes its column descriptions', () => {
  assert.ok('ok' in describeColumn(sid, uid, 'Name', 'Full name'))
  db.prepare('DELETE FROM sheets WHERE id = ?').run(sid)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM column_descriptions').get() as { n: number }).n, 0)
})

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('descriptions: all checks passed')
