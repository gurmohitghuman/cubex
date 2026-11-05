// Keeping a copy with read_rows / REST rows/query `updated_since`, through the
// real services on a migrated throwaway DB. While a column fills (an answer
// field here; clean, formula and lookup fills are listed the same way) a read
// by time answers the cells as rows hold them and names the column in
// `filling`: a fill stamps only the rows it changes, so a "⏳ Processing..."
// answered there would stay in a copy. Reads by id and page reads still show
// it. A walk's cursor is refused on another sheet, and its last time may be
// any text a row holds. A row index sent as text over REST is refused as a
// number cursor. The prune step: ids listed with return_mode ids, and
// row_ids' missing, name the rows a copy must drop.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import selMod from '../../server/src/services/row-selection'
import readMod from '../../server/src/services/workspace-read'
import trashMod from '../../server/src/services/trash-rows'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { queryRows, parseRowQueryBody } = selMod as typeof import('../../server/src/services/row-selection')
const { readRowsPage } = readMod as typeof import('../../server/src/services/workspace-read')
const { deleteRowsToTrash } = trashMod as typeof import('../../server/src/services/trash-rows')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
function sheet(columns: string[], rows: Array<Record<string, string>>) {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S_${sid.slice(0, 8)}`, JSON.stringify(columns))
  const ids = rows.map((data, i) => {
    const id = uuid()
    db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
      .run(id, sid, uid, i, JSON.stringify(data))
    return id
  })
  return { sid, ids }
}

type Row = { id: string; index: number; updated_at: string; data: Record<string, unknown> }
type Answer = { rows: Row[]; next_cursor?: string | null; as_of?: string; filling?: string[]; missing?: string[] }
async function read(sid: string, body: Record<string, unknown>): Promise<Answer> {
  const parsed = parseRowQueryBody(body, 500)
  if ('error' in parsed) throw new Error(parsed.error)
  const r = await queryRows(sid, uid, parsed.query)
  assert.ok('ok' in r, JSON.stringify(r))
  return r.ok as Answer
}
async function refusal(sid: string, body: Record<string, unknown>): Promise<string> {
  const parsed = parseRowQueryBody(body, 500)
  if ('error' in parsed) return parsed.error
  const r = await queryRows(sid, uid, parsed.query)
  assert.ok('fail' in r, JSON.stringify(r))
  return r.error
}
const SINCE = '2000-01-01T00:00:00Z'
const FILLING = '⏳ Processing...'

async function main() {
  await check('a column filling: updated_since answers the stored cells and lists it in filling', async () => {
    const S = sheet(['Name', 'Title'], [{ Name: 'Ada', Title: 'CTO' }, { Name: 'Bob' }])
    // An answer field ("Add as column") left running: nothing works it here.
    const job = uuid()
    db.prepare(`INSERT INTO enrichment_field_jobs (id,user_id,sheet_id,status_column,column_name,json_path,status)
      VALUES (?,?,?,'Name','Title','$.output.title','running')`).run(job, uid, S.sid)
    const during = await read(S.sid, { updated_since: SINCE })
    assert.deepEqual(during.rows.map(r => r.data), [{ Name: 'Ada', Title: 'CTO' }, { Name: 'Bob' }])
    assert.deepEqual(during.filling, ['Title'])
    const named = await read(S.sid, { updated_since: SINCE, columns: ['Title'], include_status: true })
    assert.deepEqual(named.rows.map(r => r.data), [{ Title: 'CTO' }, { Title: '' }])
    assert.deepEqual(named.filling, ['Title'])
    assert.deepEqual((await read(S.sid, { updated_since: SINCE, columns: ['Name'] })).filling, [],
      'only the columns read are listed')
    // Reads by id and page reads keep showing the column as filling.
    const byId = await read(S.sid, { row_ids: [S.ids[0]] })
    assert.equal(byId.rows[0].data.Title, FILLING)
    assert.equal((readRowsPage(S.sid, uid, -1, 10, false).rows[0].data as Record<string, string>).Title, FILLING)
    // The fill ends without changing Ada's row: its time never moves, and the copy already holds CTO.
    const asOf = during.as_of!
    db.prepare(`UPDATE enrichment_field_jobs SET status = 'done' WHERE id = ?`).run(job)
    const after = await read(S.sid, { updated_since: SINCE })
    assert.deepEqual(after.filling, [])
    assert.deepEqual(after.rows.map(r => [r.data.Title, r.updated_at]),
      during.rows.map(r => [r.data.Title, r.updated_at]))
    assert.deepEqual((await read(S.sid, { updated_since: asOf })).filling, [])
  })

  await check("a walk's cursor is refused on another sheet", async () => {
    const A = sheet(['N'], [{ N: '1' }, { N: '2' }])
    const B = sheet(['N'], [{ N: '1' }, { N: '2' }])
    const first = await read(A.sid, { updated_since: SINCE, limit: 1 })
    assert.ok(first.next_cursor)
    assert.match(await refusal(B.sid, { updated_since: SINCE, cursor: first.next_cursor }), /another sheet/)
    assert.equal((await read(A.sid, { updated_since: SINCE, cursor: first.next_cursor })).rows[0].data.N, '2')
  })

  await check("a cursor past a row whose updated_at isn't SQLite's form still pages", async () => {
    const S = sheet(['N'], [{ N: 'a' }, { N: 'b' }, { N: 'c' }])
    const at = db.prepare('UPDATE rows SET updated_at = ? WHERE id = ?')
    at.run('2026-01-01 10:00:00', S.ids[0])
    at.run('2026-01-01 10:00:00.500', S.ids[1])   // as an older writer or a script might have left it
    at.run('2026-01-01 10:00:01', S.ids[2])
    const seen: string[] = []
    let cursor: string | null | undefined
    do {
      const r = await read(S.sid, { updated_since: '2026-01-01T10:00:00Z', limit: 1, ...(cursor ? { cursor } : {}) })
      seen.push(...r.rows.map(x => x.data.N as string))
      cursor = r.next_cursor
    } while (cursor)
    assert.deepEqual(seen, ['a', 'b', 'c'])
  })

  await check('a row index sent as text over REST is refused as a number cursor', async () => {
    const S = sheet(['N'], [{ N: 'a' }])
    for (const body of [{ cursor: '100' }, { cursor: '100', updated_since: SINCE }, { cursor: ' 7 ' }]) {
      assert.match(await refusal(S.sid, body), /cursor must be a non-negative integer/, JSON.stringify(body))
    }
    assert.match(await refusal(S.sid, { cursor: 'abc' }), /send it with the same updated_since/)
  })

  await check('pruning a copy: return_mode ids and row_ids missing name the rows gone', async () => {
    const S = sheet(['N'], ['a', 'b', 'c', 'd'].map(N => ({ N })))
    const copy = new Map((await read(S.sid, { updated_since: SINCE })).rows.map(r => [r.id, r.data]))
    db.transaction(() => deleteRowsToTrash(S.sid, uid, 'grid', { indexes: [1, 3] }))()
    assert.equal((await read(S.sid, { updated_since: SINCE })).rows.length, 2, 'deleted rows never show')
    const live = new Set<string>()
    let cursor: number | null | undefined
    do {
      const r = await read(S.sid, { return_mode: 'ids', limit: 1, ...(cursor != null ? { cursor } : {}) })
      for (const x of r.rows) live.add(x.id)
      cursor = r.next_cursor as unknown as number | null
    } while (cursor != null)
    const gone = [...copy.keys()].filter(id => !live.has(id))
    assert.deepEqual(gone, [S.ids[1], S.ids[3]])
    assert.deepEqual((await read(S.sid, { row_ids: [...copy.keys()] })).missing, gone)
  })

  if (failures > 0) { console.error(`${failures} rows-since-copy assertion(s) failed`); process.exit(1) }
  console.log('All rows-since-copy assertions passed.')
}
main().catch(e => { console.error(e); process.exit(1) })
