// getSheetMeta (services/workspace-read.ts), which get_sheet and GET /api/v1/sheets/:id read: a sheet in the trash,
// or a sheet of a table in the trash, is not found; restored, it is found again.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { getSheetMeta } = await import('../../server/src/services/workspace-read')
runMigrations()

const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name) VALUES (?,?,?,?)').run(sid, tid, uid, 'S')

assert.equal(getSheetMeta(sid, uid)?.name, 'S')
db.prepare('UPDATE sheets SET trash_id = 7 WHERE id = ?').run(sid)
assert.equal(getSheetMeta(sid, uid), null)
console.log('ok   a sheet in the trash is not found')
db.prepare('UPDATE sheets SET trash_id = NULL WHERE id = ?').run(sid)
db.prepare('UPDATE tables SET trash_id = 8 WHERE id = ?').run(tid)
assert.equal(getSheetMeta(sid, uid), null)
console.log('ok   a sheet of a table in the trash is not found')
db.prepare('UPDATE tables SET trash_id = NULL WHERE id = ?').run(tid)
assert.equal(getSheetMeta(sid, uid)?.name, 'S')
console.log('ok   restored, it is found again')
