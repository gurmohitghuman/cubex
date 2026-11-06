// Stable row ids → row positions for a run's rows (services/run-shared.ts
// resolveRowIdsToIndexes), used by run_ai_column's target_row_ids,
// control_run's row_ids and the enrichment and waterfall reruns. SQLite takes
// at most 32,766 bound values in one statement and the surfaces take up to a
// sheet's rows: 40,000 ids resolve (they used to throw "too many SQL
// variables"), each by the primary key, in row order, through the token
// start's checks too; unknown ids are still named.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import sharedMod from '../../server/src/services/run-shared'
import tokenMod from '../../server/src/services/run-start-token'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { resolveRowIdsToIndexes } = sharedMod as typeof import('../../server/src/services/run-shared')
const { preamble } = tokenMod as typeof import('../../server/src/services/run-start-token')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

const N = 40_000
const uid = uuid(), tid = uuid(), sid = uuid(), other = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
for (const s of [sid, other]) {
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
    .run(s, tid, uid, `S-${s.slice(0, 6)}`, JSON.stringify(['Name']))
}
// Positions 0, 2, 4 …: an id's place, not its order in the list, is what comes back.
const ids: string[] = []
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
db.transaction(() => {
  for (let i = 0; i < N; i++) {
    const id = uuid()
    ids.push(id)
    insert.run(id, sid, uid, i * 2, JSON.stringify({ Name: `N${i}` }))
  }
})()
const elsewhere = uuid()
insert.run(elsewhere, other, uid, 0, '{}')

// The old way, one bound value an id, can't take them.
assert.throws(() => db.prepare(`SELECT id FROM rows WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids),
  /too many SQL variables/)
console.log('ok   one bound value an id: SQLite refuses 40,000 of them')

const reversed = [...ids].reverse()
const t = Date.now()
const r = resolveRowIdsToIndexes(sid, uid, [...reversed, ids[0], ids[1]])
const ms = Date.now() - t
assert.ok('indexes' in r, JSON.stringify(r).slice(0, 200))
assert.equal(r.indexes.length, N)
assert.ok(r.indexes.every((v, i) => v === i * 2), 'every position, in row order, duplicates once')
console.log(`ok   40,000 ids resolve to their positions, in row order (${ms} ms)`)

const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT r.id, r.row_index FROM json_each(?) AS j CROSS JOIN rows AS r
  ON r.id = j.value WHERE r.sheet_id = ? AND r.user_id = ?`).all('[]', sid, uid) as Array<{ detail: string }>
const steps = plan.map(p => p.detail).join(' | ')
assert.match(steps, /SEARCH r USING INDEX sqlite_autoindex_rows_1 \(id=\?\)/, steps)
assert.doesNotMatch(steps, /SCAN r\b/, steps)
console.log('ok   each id is looked up by the primary key, never a scan of the sheet')

const missing = [uuid(), uuid()]
const bad = resolveRowIdsToIndexes(sid, uid, [...ids, ...missing, elsewhere])
assert.ok('error' in bad)
assert.match(bad.error, new RegExp(`^Unknown row id\\(s\\): ${missing[0]}, ${missing[1]}, ${elsewhere}$`))
console.log("ok   unknown ids (and another sheet's) are still named, past 40,000 good ones")

const caller = { userId: uid, tokenId: 't', scopes: new Set(['run']) }
const pre = preamble(caller, { sheet_id: sid, target_row_ids: ids })
assert.ok('targetRowIndexes' in pre && pre.targetRowIndexes!.length === N)
console.log('ok   run_ai_column / run_http_enrichment target_row_ids take 40,000 ids')
