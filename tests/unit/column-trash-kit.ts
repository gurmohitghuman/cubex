// Shared fixture for the column trash's unit tests (migration 054): a throwaway database migrated, one account
// with an OpenRouter key, a table, the job queue recording what it is given (no run goes out), sheets of
// rows with stable ids, and the delete and restore as the app, REST and MCP call them.
import path from 'node:path'
import { createRequire } from 'node:module'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import cryptoMod from '../../server/src/lib/crypto'
import busyMod from '../../server/src/lib/sheet-busy'
import deleteMod from '../../server/src/services/column-delete'
import actionsMod from '../../server/src/services/trash-actions'
import { v4 as uuid } from 'uuid'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { encrypt } = cryptoMod as typeof import('../../server/src/lib/crypto')
const { sheetBusyWith } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { deleteSheetColumn } = deleteMod as typeof import('../../server/src/services/column-delete')
const { restoreFromTrash, holdersFirst } = actionsMod as typeof import('../../server/src/services/trash-actions')

type Opts = { surface: 'mcp' | 'rest' | 'app'; hasSecretsScope: boolean }

export function columnTrashKit(name: string) {
  if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
  runMigrations()
  console.warn = () => {}
  const enqueued: Array<{ job: string; args: unknown[] }> = []
  createRequire(path.resolve('server/src/queue.ts'))('sidequest').Sidequest.build = (cls: { name: string }) => ({
    enqueue: async (...args: unknown[]) => { enqueued.push({ job: cls.name, args }); return {} },
  })
  const uid = uuid(), tid = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
  db.prepare('INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?,?,?)')
    .run(uuid(), uid, encrypt('sk-or-test'))
  let failures = 0
  const ok = async (label: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log('ok  ', label) } catch (e) {
      failures++
      console.log('FAIL', label, '\n ', (e as Error).stack)
    }
  }
  const done = () => {
    if (failures > 0) { console.error(`${failures} ${name} assertion(s) failed`); process.exit(1) }
    console.log(`All ${name} assertions passed.`)
    process.exit(0)
  }
  // Until the sheet has been free for 50 ms with no clean, formula or lookup fill of it left (a fill that
  // waits lets the sheet go, then takes it again).
  const filling = db.prepare(`SELECT EXISTS (SELECT 1 FROM clean_columns WHERE sheet_id = ? AND fill_status = 'filling'
    UNION ALL SELECT 1 FROM formula_columns WHERE sheet_id = ? AND fill_status = 'filling'
    UNION ALL SELECT 1 FROM lookup_columns WHERE sheet_id = ? AND fill_status = 'filling')`).pluck()
  const idle = async (sid: string) => {
    for (let quiet = 0, i = 0; quiet < 10 && i < 2000; i++) {
      await new Promise(r => setTimeout(r, 5))
      quiet = sheetBusyWith(sid) || filling.get(sid, sid, sid) ? 0 : quiet + 1
    }
  }
  // A sheet with these columns and rows (row i has the id `r<i>-<sheet>` and sits at row_index i).
  const sheet = (columns: string[], rows: Array<Record<string, unknown>>, sheetName?: string) => {
    const sid = uuid()
    db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
      .run(sid, tid, uid, sheetName ?? `S_${sid.slice(0, 8)}`, JSON.stringify(columns))
    const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
    db.transaction(() => rows.forEach((r, i) => ins.run(`r${i}-${sid}`, sid, uid, i, JSON.stringify(r))))()
    return sid
  }
  const order = (sid: string) => JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck()
    .get(sid) as string) as string[]
  const cells = (sid: string, column: string) => (db.prepare(`SELECT json_extract(data, ?) FROM rows
    WHERE sheet_id = ? ORDER BY row_index`).pluck().all(`$."${column}"`, sid) as unknown[])
  const item = (id: number) => db.prepare('SELECT * FROM trash_items WHERE id = ?').get(id) as Record<string, any>
    | undefined
  const stored = (id: number) => db.prepare(`SELECT row_id, row_index, data FROM trash_rows WHERE item_id = ?
    ORDER BY seq`).all(id) as Array<{ row_id: string; row_index: number; data: string }>
  // The delete as REST and MCP call it, waiting for its strip; returns its trash id.
  const del = async (sid: string, column: string): Promise<number | null> => {
    const out = await deleteSheetColumn(sid, uid, column, { bumpDataVersion: true })
    if (!('ok' in out)) throw new Error(`delete refused: ${JSON.stringify(out)}`)
    await idle(sid)
    return out.trashId
  }
  const restore = async (ids: number[], opts: Opts = { surface: 'mcp', hasSecretsScope: true }) =>
    restoreFromTrash(uid, holdersFirst(uid, ids), opts)
  const restoreOne = async (id: number, opts?: Opts) => {
    const [r] = await restore([id], opts)
    return r
  }
  const history = (sid: string) => db.prepare(`SELECT action, column_name, summary, detail FROM sheet_changes
    WHERE sheet_id = ? ORDER BY id`).all(sid) as Array<{ action: string; column_name: string | null; summary: string;
      detail: string | null }>
  return { db, uid, tid, ok, done, idle, sheet, order, cells, item, stored, del, restore, restoreOne, history,
    enqueued }
}
