// Setup versions and an HTTP column's linked columns (services/setup-version-*.ts),
// on a migrated throwaway DB: a restore keeps earlier runs' links to the
// columns it still fills (an output cell's answers are found through them);
// a field another column fills now leaves both columns as they are, and the
// dry run says so; a spend limit that belongs to one enrichment run is no
// difference between two setups.
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
const { restoreSetupVersion } = await import('../../server/src/services/setup-version-restore')

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
function sheet(columns: string[]): string {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S${sid.slice(0, 6)}`, JSON.stringify(columns))
  return sid
}
function run(sid: string, master: string, fields: string[], extra: Record<string, unknown> = {}): string {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name)
    VALUES (?,?,?,?,'completed',?)`).run(id, sid, uid, JSON.stringify({
    requestConfig: { method: 'GET', url: 'https://example.com/{{Name}}', headers: {} },
    responseMapping: fields.map((f, i) => ({ jsonPath: `$.f${i}`, columnName: f })), ...extra }), master)
  const link = db.prepare(`INSERT INTO http_column_associations (id,sheet_id,user_id,master_column_name,
    extracted_column_name,run_id) VALUES (?,?,?,?,?,?)`)
  for (const f of fields) link.run(uuid(), sid, uid, master, f, id)
  return id
}
const save = (sid: string) => {
  const out = store.saveSetupVersion(sid, uid, { name: `v${Math.random()}` })
  assert.ok('ok' in out, JSON.stringify(out))
  return out.ok.id
}
const restore = (sid: string, id: string, dryRun = false) =>
  restoreSetupVersion(sid, uid, id, { dryRun, hasSecretsScope: true, reveal: false })
const linkedRuns = (sid: string, column: string) => db.prepare(`SELECT run_id FROM http_column_associations
  WHERE sheet_id = ? AND extracted_column_name = ? ORDER BY rowid`).pluck().all(sid, column) as string[]

await check("a restore keeps earlier runs' links to the columns it still fills", async () => {
  const sid = sheet(['Name', 'Lookup', 'Post id'])
  const h1 = run(sid, 'Lookup', ['Post id'])
  const v = save(sid)
  const h2 = run(sid, 'Lookup', ['Post id'], { batchSize: 7, runIf: '{{Name}} is not empty' })
  const out = await restore(sid, v)
  assert.ok('ok' in out && !out.ok.nothing, JSON.stringify(out))
  const runs = linkedRuns(sid, 'Post id')
  assert.ok(runs.includes(h1) && runs.includes(h2) && runs.length === 3, JSON.stringify(runs))
})

await check('a field another column fills now: both are left, and the dry run says so', async () => {
  const sid = sheet(['Name', 'Lookup', 'Post id'])
  run(sid, 'Lookup', ['Post id'])
  const v = save(sid)
  // "Post id" was deleted (Lookup's fields lost it), then a new HTTP column fills a new "Post id".
  db.prepare(`UPDATE http_runs SET config = json_set(config, '$.responseMapping', json('[]'))
    WHERE sheet_id = ? AND master_column_name = 'Lookup'`).run(sid)
  db.prepare("DELETE FROM http_column_associations WHERE sheet_id = ?").run(sid)
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?')
    .run(JSON.stringify(['Name', 'Lookup', 'Lookup2', 'Post id']), sid)
  run(sid, 'Lookup2', ['Post id'])
  const dry = await restore(sid, v, true)
  assert.ok('ok' in dry, JSON.stringify(dry))
  const by = new Map(dry.ok.columns.map(c => [c.column, c]))
  assert.equal(by.get('Lookup')!.action, 'leave')
  assert.match(by.get('Lookup')!.note ?? '',
    /Apart from the field it put in "Post id" \("Post id" is filled by "Lookup2" now\)/)
  assert.equal(by.get('Post id')!.action, 'leave')
  assert.equal(by.get('Post id')!.note, '"Lookup" doesn\'t fill it again: it is filled by "Lookup2" now.')
  assert.equal(dry.ok.nothing, true)
  const out = await restore(sid, v)
  assert.ok('ok' in out && out.ok.nothing && out.ok.saved_before === null)
})

await check("an enrichment run's own spend limit is no difference", async () => {
  const sid = sheet(['Email', 'Found', 'Phone'])
  const enrichment = (spendLimitUsd: number, rows: Record<string, unknown>) => ({ enrichment: {
    v: 1, toolId: 't1', toolName: 'Find phone', kind: 'single', preset: null, toolSnapshot: { id: 't1', at: rows },
    providerNames: {}, route: { prefer: [], exclude: [], stopAtFirst: true }, cleanDomains: false, fresh: false,
    maxCostPerRowUsd: 0.05, spendLimitUsd, rows, email: null } })
  run(sid, 'Found', ['Phone'], enrichment(0.5, { mode: 'all', test: null, where: [] }))
  const v = save(sid)
  run(sid, 'Found', ['Phone'], enrichment(0.15, { mode: 'rerun', status: 'failed', test: 3, where: [] }))
  const dry = await restore(sid, v, true)
  assert.ok('ok' in dry && dry.ok.nothing, JSON.stringify(dry))
})

if (failures) { console.error(`${failures} failed`); process.exit(1) }
console.log('setup-versions-links: all passed')
