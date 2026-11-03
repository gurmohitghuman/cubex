// Rows auto-dedupe removes show in the sheet's History (services/removal-log.ts):
// one line for a run of them, by Cubex whoever's rows came in, naming the key
// column and the day's trash batch (so History offers Restore); a later change
// in between starts a new line; with the trash kept 0 days the line names no batch.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import settingMod from '../../server/src/services/auto-dedupe-setting'
import indexMod from '../../server/src/services/auto-dedupe-index'
import rowsMod from '../../server/src/services/rows-write'
import historyMod from '../../server/src/services/sheet-history'
import logMod from '../../server/src/lib/change-log'
import actorMod from '../../server/src/lib/actor'
import removalMod from '../../server/src/services/removal-log'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { setAutoDedupe } = settingMod as typeof import('../../server/src/services/auto-dedupe-setting')
const { maintainAutoDedupeSheet } = indexMod as typeof import('../../server/src/services/auto-dedupe-index')
const { appendRows } = rowsMod as typeof import('../../server/src/services/rows-write')
const { readSheetHistory } = historyMod as typeof import('../../server/src/services/sheet-history')
const { logSheetChange } = logMod as typeof import('../../server/src/lib/change-log')
const { runAs } = actorMod as typeof import('../../server/src/lib/actor')
const { logRemoval } = removalMod as typeof import('../../server/src/services/removal-log')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
  .run(sid, tid, uid, 'Leads', JSON.stringify(['Email', 'Name']))
db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
  .run(uuid(), sid, uid, 0, JSON.stringify({ Email: 'a@x.com' }))

let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
// An agent's append: the rows are the agent's, the removals Cubex's.
const AGENT = { via: 'mcp' as const, tokenName: 'Lead bot', tokenId: 'tok-1' }
const append = (rows: Array<Record<string, string>>) => runAs(AGENT, () => {
  const out = appendRows(sid, uid, rows)
  assert.ok('ok' in out, JSON.stringify(out))
  return out.ok
})
type Line = { id: number; via: string; action: string; column_name: string | null; summary: string; detail: string }
const removalLines = () => db.prepare(`SELECT id, via, action, column_name, summary, detail FROM sheet_changes
  WHERE sheet_id = ? AND action = 'rows_deleted' ORDER BY id`).all(sid) as Line[]
const batch = () => db.prepare(`SELECT id FROM trash_items WHERE sheet_id = ? AND how = 'auto_dedupe'`).pluck().get(sid)

async function main() {
  assert.ok('ok' in setAutoDedupe(uid, sid, { column: 'Email', match: 'email', keep: 'oldest' }))
  assert.equal(await maintainAutoDedupeSheet(sid, uid, Date.now() + 10_000), 'ready')

  await ok('a removal writes one line: Cubex, the key column, the day\'s batch', () => {
    assert.equal(append([{ Email: 'A@x.com' }, { Email: 'b@x.com' }, { Email: 'B@X.com ' }]).kept, 1)
    const lines = removalLines()
    assert.equal(lines.length, 1)
    const [line] = lines
    assert.equal(line.via, 'cubex')
    assert.equal(line.column_name, 'Email')
    assert.equal(line.summary, 'Auto-dedupe removed 2 rows: another row has the same "Email"')
    assert.deepEqual(JSON.parse(line.detail), { rows: 2, trash_id: batch(), how: 'auto_dedupe' })
    assert.equal(db.prepare(`SELECT via FROM trash_items WHERE id = ?`).pluck().get(batch()), 'cubex',
      'the trash batch says Cubex too, not the agent whose rows came in')
  })

  await ok('more removals right after count on the same line', () => {
    append([{ Email: 'a@x.com' }])
    append([{ Email: 'b@x.com' }, { Email: 'c@x.com' }])
    const lines = removalLines()
    assert.equal(lines.length, 1)
    assert.equal(lines[0].summary, 'Auto-dedupe removed 4 rows: another row has the same "Email"')
    assert.equal(JSON.parse(lines[0].detail).rows, 4)
  })

  await ok('History offers the batch: its line says the rows are in the trash', () => {
    const page = readSheetHistory(sid, uid, { column: 'Email' })
    const line = page.changes.find(c => c.action === 'rows_deleted')
    assert.equal(line?.in_trash, true)
    assert.equal(line?.by !== undefined, true)
  })

  await ok('a change logged in between starts a new line for the next removals', () => {
    logSheetChange(sid, uid, 'description', 'Described "Email"')
    append([{ Email: 'c@x.com' }])
    const lines = removalLines()
    assert.equal(lines.length, 2)
    assert.equal(lines[1].summary, 'Auto-dedupe removed 1 row: another row has the same "Email"')
    assert.equal(JSON.parse(lines[1].detail).trash_id, batch(), 'the same day\'s batch')
  })

  await ok('a list rerun\'s lines and auto-dedupe\'s, written in turn, each keep counting on their own line', () => {
    logSheetChange(sid, uid, 'description', 'Described "Email" again')
    const rerun = (n: number) => logRemoval({ sheetId: sid, userId: uid, how: 'rerun', trashId: 999, count: n,
      summary: k => `A rerun replaced ${k} rows it had added before` })
    const before = removalLines().length
    rerun(2)
    append([{ Email: 'a@x.com' }])
    rerun(3)
    append([{ Email: 'b@x.com' }])
    const lines = removalLines().slice(before)
    assert.deepEqual(lines.map(l => l.summary), ['A rerun replaced 5 rows it had added before',
      'Auto-dedupe removed 2 rows: another row has the same "Email"'])
  })

  await ok('with deleted rows kept 0 days, the line names no batch', () => {
    db.prepare('INSERT INTO settings (id, user_id, trash_days) VALUES (?,?,0)').run(uuid(), uid)
    logSheetChange(sid, uid, 'description', 'Described "Name"')
    append([{ Email: 'a@x.com' }])
    const last = removalLines().at(-1)!
    assert.deepEqual(JSON.parse(last.detail), { rows: 1, trash_id: null, how: 'auto_dedupe' })
  })

  await ok('a row auto-dedupe keeps writes no removal line', () => {
    const before = removalLines().length
    append([{ Email: 'fresh@x.com' }])
    assert.equal(removalLines().length, before)
  })
}

main()
  .catch(err => { failures++; console.log('FAIL threw', err) })
  .finally(() => { if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) } })
