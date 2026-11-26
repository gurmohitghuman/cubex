// Two uses of one setup on a sheet at once (services/setup-apply.ts): each prices the setup (an await, with a cost
// ceiling) between its check for another live setup making the same columns and writing its record, so both
// used to pass the check and both start, the second making the same columns again after the first. The check is
// made again right before the record is written: one starts, the other is refused with the usual answer, naming
// the column. An export holds the sheet meanwhile, so the first setup's step waits and its record stays live.
// Then, the first done, the same setup starts again.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { insertSetup } = await import('../../server/src/services/setup-library')
const { applySetup } = await import('../../server/src/services/setup-apply')
const { applyInputOf } = await import('../../server/src/services/setup-apply-input')
const { withSheetRead } = await import('../../server/src/lib/sheet-busy')
type Spec = import('../../server/src/lib/setups/spec').SetupSpec
runMigrations()
console.warn = () => {}

const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
  .run(sid, tid, uid, 'People', JSON.stringify(['Name']))
for (let i = 0; i < 5; i++) {
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
    .run(uuid(), sid, uid, i, JSON.stringify({ Name: `  Person ${i} ` }))
}
const spec: Spec = { v: 1, inputs: ['Name'], keys: [], steps: [
  { kind: 'clean', name: 'Trimmed', source: 'Name', cleaner: 'trim', options: {}, autoRun: false },
] }
const made = insertSetup(uid, 'Trim', null, spec)
if (!('ok' in made)) throw new Error(JSON.stringify(made))
const input = applyInputOf({ max_cost_usd: 1 }, 'v1')
if ('fail' in input) throw new Error(input.message)
const live = () => db.prepare(`SELECT COUNT(*) FROM setup_runs WHERE sheet_id = ? AND status IN ('running', 'paused')`)
  .pluck().get(sid) as number

let release = () => {}
const held = withSheetRead(sid, () => new Promise<void>(r => { release = r }))
const twice = await Promise.all([1, 2].map(() => applySetup(uid, sid, made.ok.id, input, { hasSecretsScope: true })))
const outcomes = twice.map(o => ('fail' in o ? o.fail : 'started')).sort()
assert.deepEqual(outcomes, ['conflict', 'started'], JSON.stringify(twice))
// The usual refusal, naming the column (its words changed on main with column runs, so not matched here).
const refused = twice.find(o => 'fail' in o) as { fail: string; taken?: string[] }
assert.deepEqual(refused.taken, ['Trimmed'], JSON.stringify(refused))
assert.equal(live(), 1)
console.log('ok   two uses at once: one starts, the other is refused, never a second record making the same column')

db.prepare(`UPDATE setup_runs SET status = 'cancelled' WHERE sheet_id = ? AND status IN ('running', 'paused')`)
  .run(sid)
release()
await held
const again = await applySetup(uid, sid, made.ok.id, input, { hasSecretsScope: true })
assert.ok('ok' in again, JSON.stringify(again))
console.log('ok   the first one over, the same setup starts again')
