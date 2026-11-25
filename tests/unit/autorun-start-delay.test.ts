// An auto-run's start delay (migration 072, services/autorun-pick.ts): a waiting row is taken once it has gone
// start_delay_s without being queued again, a new row once it has gone that long without a write, and the
// watermark stops before the first new row too young (looked at again next time); a row not due stays queued; a
// write queues a row again and starts its wait over; with no delay every row is taken at once, as before.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import pickMod from '../../server/src/services/autorun-pick'
import entryMod from '../../server/src/services/autorun-entry'
import markMod from '../../server/src/lib/autorun-mark'
import type { CandidatePlan } from '../../server/src/lib/autorun-rules'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { pickRows } = pickMod as typeof import('../../server/src/services/autorun-pick')
const { loadEntry } = entryMod as typeof import('../../server/src/services/autorun-entry')
const { markAutorunInputs } = markMod as typeof import('../../server/src/lib/autorun-mark')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).stack)
  }
}
const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
// An HTTP API column reading Name: a row with a Name and no Status is ready.
const plan = { kind: 'http', statusColumn: 'Status', config: { requestConfig: { method: 'GET', url: 'x' } },
  columns: ['Name', 'Status'], requestCols: ['Name'], where: [], rule: null } as unknown as CandidatePlan
const OLD = "datetime('now', '-120 seconds')"

// Rows 0-4 with a Name; rows 0 and 1 below the watermark and queued (row 0 two minutes ago, row 1 just now); rows
// 2-4 new, written two minutes ago, just now, two minutes ago.
function fixture(delayS: number) {
  const sid = uuid(), entry = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
    .run(sid, tid, uid, `S-${sid.slice(0, 6)}`, JSON.stringify(['Name', 'Status']))
  const ids = [0, 1, 2, 3, 4].map(i => {
    const id = uuid()
    db.prepare(`INSERT INTO rows (id,sheet_id,user_id,row_index,data,updated_at) VALUES (?,?,?,?,?,
      ${i === 3 ? "datetime('now')" : OLD})`).run(id, sid, uid, i, JSON.stringify({ Name: `N${i}` }))
    return id
  })
  db.prepare(`INSERT INTO autorun_columns (id,user_id,sheet_id,status_column,kind,input_columns,watermark_row_index,
    start_delay_s) VALUES (?,?,?,'Status','http','["Name"]',1,?)`).run(entry, uid, sid, delayS)
  db.prepare(`INSERT INTO autorun_pending (autorun_id,user_id,row_id,created_at) VALUES (?,?,?,${OLD})`)
    .run(entry, uid, ids[0])
  db.prepare('INSERT INTO autorun_pending (autorun_id,user_id,row_id) VALUES (?,?,?)').run(entry, uid, ids[1])
  return { sid, entry, ids }
}
const queued = (entry: string) => (db.prepare('SELECT row_id FROM autorun_pending WHERE autorun_id = ?').pluck()
  .all(entry) as string[]).sort()

async function main() {
  await ok('60 s: the queued row and the new row past it taken; the young ones wait, the watermark before them',
    async () => {
      const f = fixture(60)
      const picked = await pickRows(loadEntry(f.entry)!, plan, 100)
      assert.deepEqual(picked.rows, [{ id: f.ids[0], fromPending: true }, { id: f.ids[2], fromPending: false }])
      assert.equal(picked.watermark, 2, 'stops before row 3, so row 4 is looked at again next time too')
      assert.deepEqual(queued(f.entry), [f.ids[0], f.ids[1]].sort(), 'row 1 still queued, not dropped')
    })

  await ok('no delay: every row at once, as before', async () => {
    const f = fixture(0)
    const picked = await pickRows(loadEntry(f.entry)!, plan, 100)
    assert.deepEqual(picked.rows.map(r => r.id).sort(), [...f.ids].sort())
    assert.equal(picked.watermark, 4)
  })

  await ok('a write queues a row again and starts its wait over', async () => {
    const f = fixture(60)
    markAutorunInputs(f.sid, uid, ['Name'], { ids: [f.ids[0]] })
    const picked = await pickRows(loadEntry(f.entry)!, plan, 100)
    assert.deepEqual(picked.rows, [{ id: f.ids[2], fromPending: false }], 'row 0 was just written')
    assert.deepEqual(queued(f.entry), [f.ids[0], f.ids[1]].sort())
  })

  if (failures > 0) { console.error(`${failures} autorun-start-delay check(s) failed`); process.exit(1) }
  console.log('autorun-start-delay: all assertions passed')
}
void main()
