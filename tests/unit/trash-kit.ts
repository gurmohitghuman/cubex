// Shared fixture for the trash's unit tests (trash-rows, trash-jobs,
// trash-sheets): a throwaway database migrated, one account and table, a sheet
// of n rows at positions 0, 2, 4… with an AI run holding a result on every
// third row, and small readers.
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import trashRowsMod from '../../server/src/services/trash-rows'
import busyMod from '../../server/src/lib/sheet-busy'
import { v4 as uuid } from 'uuid'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { deleteRowsToTrash } = trashRowsMod as typeof import('../../server/src/services/trash-rows')
const { sheetBusyWith } = busyMod as typeof import('../../server/src/lib/sheet-busy')

export function trashKit(name: string) {
  if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
  runMigrations()
  console.warn = () => {}
  const uid = uuid(), tid = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
  let failures = 0
  const ok = async (label: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log('ok  ', label) }
    catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
  }
  const done = () => {
    if (failures > 0) { console.error(`${failures} ${name} assertion(s) failed`); process.exit(1) }
    console.log(`All ${name} assertions passed.`)
    process.exit(0)
  }
  const idle = async (sid: string) => { while (sheetBusyWith(sid)) await new Promise(r => setTimeout(r, 5)) }
  const fixture = (n: number, columns = ['Email', 'Name'], table = tid) => {
    const sid = uuid()
    db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
      .run(sid, table, uid, `S_${sid.slice(0, 8)}`, JSON.stringify(columns))
    const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
    const ai = uuid()
    db.transaction(() => {
      for (let i = 0; i < n; i++) {
        ins.run(`r${i}-${sid}`, sid, uid, i * 2, JSON.stringify({ Email: `u${i % 7}@a.com`, Name: `N${i}` }))
      }
      db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,status)
        VALUES (?,?,?,'Name','p','completed')`).run(ai, sid, uid)
      for (let i = 0; i < n; i += 3) {
        db.prepare('INSERT INTO ai_results (id,run_id,user_id,row_index) VALUES (?,?,?,?)').run(uuid(), ai, uid, i * 2)
      }
    })()
    return sid
  }
  const rowsOf = (sid: string) => db.prepare(`SELECT id, row_index, data FROM rows WHERE sheet_id = ?
    ORDER BY row_index`).all(sid) as Array<{ id: string; row_index: number; data: string }>
  const item = (id: number) => db.prepare('SELECT * FROM trash_items WHERE id = ?').get(id) as
    { row_count: number; state: string; how: string; columns: string; bytes: number } | undefined
  const del = (sid: string, indexes: number[], cont?: number) =>
    db.transaction(() => deleteRowsToTrash(sid, uid, 'grid', { indexes }, cont))()
  return { db, uid, tid, ok, done, idle, fixture, rowsOf, item, del }
}
