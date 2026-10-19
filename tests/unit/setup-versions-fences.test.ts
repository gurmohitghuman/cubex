// Over 200 lines: the restore's fences and refusals, the list's counts and the rename's reach, one DB.
// Setup versions on a migrated throwaway DB (services/setup-version-*.ts): a
// restore starts no fill, so a clean column's auto-run already on keeps its
// fence (rows that came meanwhile still get their value) and one it turns on
// starts above the rows there; a clean, formula or lookup column still filling
// refuses a restore, the dry run too; the list counts columns in SQL as
// parseVersionSpec reads them; a rename reaches every version that names the
// column (any case, the normalized name, a lower-casing to ASCII, a name with
// no a-z0-9, another sheet's lookup) and reads only those. Timings at
// SETUP_VERSIONS_PERF_MB per version (default 0.25; the cap is 4) are printed.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
async function check(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).stack)
  }
}

runMigrations()
const store = await import('../../server/src/services/setup-version-store')
const { renameSetupVersionRefs } = await import('../../server/src/services/setup-version-rename')
const { restoreSetupVersion } = await import('../../server/src/services/setup-version-restore')
const { setDerivedAutorun } = await import('../../server/src/services/derived-autorun')
const { derivedFollowTick } = await import('../../server/src/services/derived-follow')
const { entryFor } = await import('../../server/src/services/autorun-entry')
const { writeColumnDescription } = await import('../../server/src/lib/column-descriptions')
const { renameNeedle } = await import('../../server/src/lib/setup-versions/rename')
const { MAX_SETUP_VERSIONS_PER_SHEET } = await import('../../server/src/lib/constants-setups')

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
function sheet(columns: string[]): string {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S${sid.slice(0, 6)}`, JSON.stringify(columns))
  return sid
}
const addRow = (sid: string, i: number, data: Record<string, string>) =>
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
    .run(uuid(), sid, uid, i, JSON.stringify(data))
const cell = (sid: string, i: number, c: string) => (JSON.parse(db.prepare(`SELECT data FROM rows
  WHERE sheet_id = ? AND row_index = ?`).pluck().get(sid, i) as string) as Record<string, string>)[c]
const entry = (sid: string, c: string) => db.prepare(`SELECT enabled, watermark_row_index AS w FROM autorun_columns
  WHERE sheet_id = ? AND status_column = ?`).get(sid, c) as { enabled: number; w: number }
const save = (sid: string, name: string) => {
  const out = store.saveSetupVersion(sid, uid, { name })
  assert.ok('ok' in out, JSON.stringify(out))
  return out.ok.id
}
const restore = (sid: string, id: string, dryRun = false) =>
  restoreSetupVersion(sid, uid, id, { dryRun, hasSecretsScope: true, reveal: false })

// A clean column following Name, its auto-run on with its fence at the last row.
const A = sheet(['Name', 'Clean'])
addRow(A, 0, { Name: 'ada lovelace', Clean: 'Ada Lovelace' })
addRow(A, 1, { Name: 'alan turing', Clean: 'Alan Turing' })
db.prepare(`INSERT INTO clean_columns (id,user_id,sheet_id,column_name,source_column,cleaner,options,fill_status)
  VALUES (?,?,?,'Clean','Name','person_name','{}','done')`).run(uuid(), uid, A)
setDerivedAutorun('clean', A, uid, 'Clean', ['Name'], true)
const vA = save(A, 'person names')

await check('an auto-run on keeps its fence through a restore: rows that came meanwhile get their value', async () => {
  assert.equal(entry(A, 'Clean').w, 1)
  db.prepare("UPDATE clean_columns SET cleaner = 'first_name' WHERE sheet_id = ?").run(A)
  addRow(A, 2, { Name: 'grace hopper' })
  addRow(A, 3, { Name: 'edsger dijkstra' })
  const out = await restore(A, vA)
  assert.ok('ok' in out, JSON.stringify(out))
  assert.equal(db.prepare('SELECT cleaner FROM clean_columns WHERE sheet_id = ?').pluck().get(A), 'person_name')
  assert.deepEqual(entry(A, 'Clean'), { enabled: 1, w: 1 })
  assert.equal(cell(A, 0, 'Clean'), 'Ada Lovelace', 'no cell written by the restore')
  await derivedFollowTick(entryFor(A, uid, 'Clean')!)
  assert.equal(cell(A, 2, 'Clean'), 'Grace Hopper')
  assert.equal(cell(A, 3, 'Clean'), 'Edsger Dijkstra')
})

await check('an auto-run a restore turns on starts above the rows there now: nothing fills them', async () => {
  setDerivedAutorun('clean', A, uid, 'Clean', ['Name'], false)
  addRow(A, 4, { Name: 'barbara liskov' })
  const out = await restore(A, vA)
  assert.ok('ok' in out && !out.ok.nothing, JSON.stringify(out))
  assert.deepEqual(entry(A, 'Clean'), { enabled: 1, w: 4 })
  await derivedFollowTick(entryFor(A, uid, 'Clean')!)
  assert.equal(cell(A, 4, 'Clean'), undefined)
  addRow(A, 5, { Name: 'ken thompson' })
  await derivedFollowTick(entryFor(A, uid, 'Clean')!)
  assert.equal(cell(A, 5, 'Clean'), 'Ken Thompson')
})

await check('a clean, formula or lookup column still filling refuses a restore, and the dry run says so', async () => {
  const other = sheet(['Key', 'Value'])
  const B = sheet(['Name', 'Clean', 'L', 'F'])
  addRow(B, 0, { Name: 'x' })
  db.prepare(`INSERT INTO lookup_columns (id,user_id,sheet_id,column_name,source_column,other_sheet_id,match_column,
    match_mode,returns,return_columns,fill_status) VALUES (?,?,?,'L','Name',?,'Key','equals','value','["Value"]',
    'filling')`).run(uuid(), uid, B, other)
  const v = save(B, 'with a lookup')
  writeColumnDescription(B, uid, 'Name', 'Changed since')
  for (const [table, column] of [['lookup_columns', 'L'], ['clean_columns', 'Clean'], ['formula_columns', 'F']]) {
    if (table === 'clean_columns') {
      db.prepare(`INSERT INTO clean_columns (id,user_id,sheet_id,column_name,source_column,cleaner,options)
        VALUES (?,?,?,'Clean','Name','person_name','{}')`).run(uuid(), uid, B)
    }
    if (table === 'formula_columns') {
      db.prepare(`INSERT INTO formula_columns (id,user_id,sheet_id,column_name,formula,inputs)
        VALUES (?,?,?,'F','{{Name}}','["Name"]')`).run(uuid(), uid, B)
    }
    const dry = await restore(B, v, true)
    assert.ok('ok' in dry, JSON.stringify(dry))
    assert.match(dry.ok.blocked ?? '', new RegExp(`^"${column}" is still being filled`))
    const out = await restore(B, v)
    assert.ok('fail' in out && out.fail === 'conflict', JSON.stringify(out))
    assert.match(out.message, new RegExp(`^"${column}" is still being filled`))
    db.prepare(`UPDATE ${table} SET fill_status = 'done' WHERE sheet_id = ?`).run(B)
  }
  const dry = await restore(B, v, true)
  assert.ok('ok' in dry && dry.ok.blocked === null, JSON.stringify(dry))
})

// Versions written as stored text, so a test can hold what a save never would.
const insertSpec = (sid: string, name: string, spec: string) => {
  const id = uuid()
  db.prepare(`INSERT INTO setup_versions (id,user_id,sheet_id,name,spec) VALUES (?,?,?,?,?)`)
    .run(id, uid, sid, name, spec)
  return id
}
const specOf = (id: string) => db.prepare('SELECT spec FROM setup_versions WHERE id = ?').pluck().get(id) as string
const ai = (prompt: string) => ({ kind: 'ai', prompt, runIf: null, outputColumns: null, dataColumn: null })
const http = (url: string) => ({ kind: 'http', mode: 'http', allowSecrets: 0, destSheetId: null, extracted: [],
  config: { requestConfig: { method: 'GET', url, headers: {} }, responseMapping: [] } })
const col = (name: string, fill: unknown = null) => ({ name, description: null, fill, autoRun: null })

await check('the list counts columns and filled columns in SQL, as reading the version does', () => {
  const C = sheet(['A'])
  const good = insertSpec(C, 'good', JSON.stringify({ v: 1, columns: [col('A'), col('B', ai('/a')),
    col('C', http('https://example.com/{{A}}'))] }))
  insertSpec(C, 'not json', '{"v":1,"columns":[')
  insertSpec(C, 'newer', JSON.stringify({ v: 2, columns: [col('A')] }))
  insertSpec(C, 'odd items', JSON.stringify({ v: 1, columns: ['x', 3, null, col('A', ai('p'))] }))
  const by = new Map(store.listSetupVersions(C, uid)!.map(v => [v.name, [v.columns, v.filled]]))
  assert.deepEqual(Object.fromEntries(by), { good: [3, 2], 'not json': [0, 0], newer: [0, 0], 'odd items': [4, 1] })
  const read = store.readSetupVersion(C, uid, good)
  assert.ok(!('fail' in read))
  assert.deepEqual([read.info.columns, read.info.filled], [3, 2])
})

await check('a rename reaches every version naming the column, however it is named, in this sheet and others', () => {
  assert.deepEqual(renameNeedle('Company Name'), { like: '%company%', also: [] })
  assert.deepEqual(renameNeedle('Big Kite'),
    { like: '%kite%', also: [String.fromCodePoint(0x130), String.fromCodePoint(0x212a)] })
  assert.equal(renameNeedle('名前'), null)
  const D = sheet(['Company Name', 'Key', '名前', 'Out'])
  const E = sheet(['X'])
  const kelvin = String.fromCodePoint(0x212a)
  const version = (name: string, ...columns: unknown[]) => insertSpec(D, name, JSON.stringify({ v: 1, columns }))
  const prompt = version('prompt', col('Out', ai('About /company_name, /KEY')))
  const loose = version('loose', col('Out', http('https://e.com/{{Company-Name}}')))
  const kel = version('kelvin', col('Out', http(`https://e.com/{{${kelvin}ey}}`)))
  const cjk = version('cjk', col('名前'), col('Out', http('https://e.com/{{名前}}')))
  const none = version('none', col('Out', ai('Nothing here')))
  const lookup = { kind: 'lookup', source: 'X', otherSheetId: D, matchColumn: 'Key', match: 'equals', returns: 'value',
    returnColumns: ['Company Name'], limit: 10 }
  const there = insertSpec(E, 'there', JSON.stringify({ v: 1, columns: [col('X'), col('L', lookup)] }))
  const noneBefore = specOf(none)
  db.transaction(() => {
    renameSetupVersionRefs(D, uid, 'Company Name', 'Firm')
    renameSetupVersionRefs(D, uid, 'Key', 'Clé')
    renameSetupVersionRefs(D, uid, '名前', 'Nom')
  }).immediate()
  assert.equal(JSON.parse(specOf(prompt)).columns[0].fill.prompt, 'About /firm, /cl')
  assert.equal(JSON.parse(specOf(loose)).columns[0].fill.config.requestConfig.url, 'https://e.com/{{Firm}}')
  assert.equal(JSON.parse(specOf(kel)).columns[0].fill.config.requestConfig.url, 'https://e.com/{{Clé}}')
  const c = JSON.parse(specOf(cjk))
  assert.deepEqual([c.columns[0].name, c.columns[1].fill.config.requestConfig.url], ['Nom', 'https://e.com/{{Nom}}'])
  assert.equal(specOf(none), noneBefore)
  const l = JSON.parse(specOf(there)).columns[1].fill
  assert.deepEqual([l.matchColumn, l.returnColumns], ['Clé', ['Firm']])
})

await check(`timings: ${MAX_SETUP_VERSIONS_PER_SHEET} versions on a sheet and as many on another`, () => {
  const mb = Number(process.env.SETUP_VERSIONS_PERF_MB || 0.25)
  const P = sheet(['Name']), Q = sheet(['Name'])
  const per = Math.floor((mb * 1024 * 1024) / 200)
  const filler = 'lorem ipsum dolor sit amet '.repeat(Math.ceil(per / 27)).slice(0, per)
  const spec = JSON.stringify({ v: 1, columns: Array.from({ length: 200 }, (_, i) =>
    col(`C${i}`, i % 2 ? ai(`${filler} /name`) : null)) })
  db.transaction(() => {
    for (let i = 0; i < MAX_SETUP_VERSIONS_PER_SHEET; i++) {
      insertSpec(P, `p${i}`, spec)
      insertSpec(Q, `q${i}`, spec)
    }
  }).immediate()
  const time = (fn: () => void) => { const t = performance.now(); fn(); return Math.round(performance.now() - t) }
  let listed = 0
  const list = time(() => { listed = store.listSetupVersions(P, uid)!.length })
  assert.equal(listed, MAX_SETUP_VERSIONS_PER_SHEET)
  const miss = time(() => db.transaction(() => renameSetupVersionRefs(P, uid, 'Zebra', 'Zebu')).immediate())
  const hit = time(() => db.transaction(() => renameSetupVersionRefs(P, uid, 'Name', 'Full name')).immediate())
  assert.ok(JSON.parse(specOf(db.prepare("SELECT id FROM setup_versions WHERE name = 'p0'").pluck().get() as string))
    .columns[1].fill.prompt.endsWith('/full_name'))
  console.log(`     ${mb} MB a version: list ${list} ms; a rename naming no version ${miss} ms, naming all `
    + `${MAX_SETUP_VERSIONS_PER_SHEET} ${hit} ms`)
})

if (failures) { console.error(`${failures} failed`); process.exit(1) }
console.log('setup-versions-fences: all passed')
