// Lookup columns at their edges, against a migrated throwaway DB: a source
// built while its sheet sorts still gets every row, at its final position (a
// build reading rows a page at a time by position saw some twice and missed
// others); a contains value whose trigrams weren't in the index yet is found
// once a row brings them (a count cached as none must never decide).
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import colMod from '../../server/src/services/lookup-column'
import fillMod from '../../server/src/services/derived-fill'
import kindMod from '../../server/src/services/lookup-kind'
import sortMod from '../../server/src/services/sheet-sort'
import sourceMod from '../../server/src/services/lookup-source'
import maintainMod from '../../server/src/services/lookup-maintain'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { startLookupColumn } = colMod as typeof import('../../server/src/services/lookup-column')
const { waitForDerivedFill } = fillMod as typeof import('../../server/src/services/derived-fill')
const { lookupKind } = kindMod as typeof import('../../server/src/services/lookup-kind')
const { physicalSortSheet } = sortMod as typeof import('../../server/src/services/sheet-sort')
const { ensureLookupSource } = sourceMod as typeof import('../../server/src/services/lookup-source')
const { maintainLookupSheet } = maintainMod as typeof import('../../server/src/services/lookup-maintain')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid(), t = uuid(), S = uuid(), L = uuid(), N = 20_000
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(t, uid, 'R')
const sheet = db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
sheet.run(S, t, uid, 'Sorted', JSON.stringify(['Site', 'Rank']))
sheet.run(L, t, uid, 'Looks', JSON.stringify(['Company']))
const add = (s: string, data: Record<string, string>) => {
  const i = (db.prepare('SELECT IFNULL(MAX(row_index), -1) + 1 FROM rows WHERE sheet_id = ?').pluck().get(s) as number)
  db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    .run(uuid(), s, uid, i, JSON.stringify(data))
}
const cells = (s: string, col: string) => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index')
  .pluck().all(s) as string[]).map(d => JSON.parse(d)[col])

async function main() {
  const ins = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < N; i++) {
      ins.run(uuid(), S, uid, i, JSON.stringify({ Site: `s${i}.com`, Rank: String((i * 7919) % N).padStart(6, '0') }))
    }
  })()
  db.transaction(() => ensureLookupSource(uid, S, 'Site', false)).immediate()
  const sorting = physicalSortSheet(S, uid, 'Rank', 'asc')
  await new Promise(r => setImmediate(r))
  await maintainLookupSheet(S, uid, Date.now() + 30_000)
  await sorting
  await maintainLookupSheet(S, uid, Date.now() + 30_000)
  const ofSheet = 'FROM lookup_keys k JOIN lookup_sources s ON s.id = k.source_id'
  const keys = db.prepare(`SELECT count(*) ${ofSheet} WHERE s.sheet_id = ?`).pluck().get(S)
  const off = db.prepare(`SELECT count(*) ${ofSheet} JOIN rows r ON r.rowid = k.rid
    WHERE s.sheet_id = ? AND k.row_index <> r.row_index`).pluck().get(S)
  check('a source built while its sheet sorts has every row, at its final position', keys === N && off === 0,
    { keys, off })

  add(L, { Company: 'zebra' })
  add(S, { Site: 'acme', Rank: '999999' })
  const args = { column: 'Found', sourceColumn: 'Company', otherSheetId: S, matchColumn: 'Site', match: 'contains',
    returns: 'exists', autoRun: false }
  let out = await startLookupColumn(uid, L, args)
  if ('ok' in out) await waitForDerivedFill(lookupKind, out.ok.id, 8_000)
  check('contains: no row holds it yet', cells(L, 'Found')[0] === 'No', cells(L, 'Found'))
  add(S, { Site: 'Zebra Crossing', Rank: '999998' })
  out = await startLookupColumn(uid, L, args)
  if ('ok' in out) await waitForDerivedFill(lookupKind, out.ok.id, 8_000)
  check('contains: a trigram that came later is matched', cells(L, 'Found')[0] === 'Yes', cells(L, 'Found'))

  console.log(failures === 0 ? '\nlookup races: all passed' : `\nlookup races: ${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
