// A new setup for an existing HTTP API column (services/http-setup-change.ts) may name the columns it already
// fills again, exactly as they are (lib/http-run-validate.ts checkExisting.except). Any other spelling of one of
// them ("x" for "X", or the same /token) would be a second column whose name differs only in case, so it clashes,
// as does any other column of the sheet. Imports open the DB (lib/db.ts): DB_PATH must be a throwaway path.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import validateMod from '../../server/src/lib/http-run-validate'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { validateHttpRunColumns } = validateMod as typeof import('../../server/src/lib/http-run-validate')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'S', JSON.stringify(['val', 'Lookup', 'X']))

const own = { except: ['Lookup', 'X'] }
const save = (...names: string[]) =>
  validateHttpRunColumns(sid, uid, names.map(n => ({ jsonPath: '$.a', columnName: n })), 'Lookup', own)

check('its own columns, named as they are', save('X').ok, save('X'))
check('a new column', save('Y').ok, save('Y'))
check('its own column in another case clashes', /case-insensitive/.test(save('x').error ?? ''), save('x'))
check('another column of the sheet clashes', /already exists/.test(save('val').error ?? ''), save('val'))
check('a start that runs (no own columns) clashes with them', !validateHttpRunColumns(sid, uid,
  [{ jsonPath: '$.a', columnName: 'X' }], 'Other', true).ok)

if (failures) { console.error(`${failures} failed`); process.exit(1) }
console.log('all http-setup-own-columns checks passed')
