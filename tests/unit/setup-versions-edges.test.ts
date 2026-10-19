// Setup versions, the edges of a restore (services/setup-version-*.ts) on a
// migrated throwaway DB: a field column that is another kind now stays out of
// the restored HTTP column (never linked to it again), and an AI column whose
// output is another kind now is left; links narrow to what the restored setup
// picks; the search engine an AI run resolved comes back; a caller without
// 'secrets' freezes saved keys off; the version being restored is never the
// copy a full sheet drops; a loop is told before anything is written; a sheet
// whose only difference is a column left as it is has nothing to restore,
// and that column's description isn't touched.
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
const { writeColumnDescription } = await import('../../server/src/lib/column-descriptions')
const { MAX_SETUP_VERSIONS_PER_SHEET } = await import('../../server/src/lib/constants-setups')

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
function sheet(columns: string[]): string {
  const sid = uuid()
  db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
    .run(sid, tid, uid, `S${sid.slice(0, 6)}`, JSON.stringify(columns))
  db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,0,?)').run(uuid(), sid, uid, '{}')
  return sid
}
const setOrder = (sid: string, cols: string[]) =>
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?').run(JSON.stringify(cols), sid)
function http(sid: string, master: string, fields: string[], allowSecrets = 1) {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id,sheet_id,user_id,config,status,master_column_name,allow_secrets)
    VALUES (?,?,?,?,'completed',?,?)`).run(id, sid, uid, JSON.stringify({
    requestConfig: { method: 'GET', url: 'https://example.com/{{Name}}', headers: {} },
    responseMapping: fields.map((f, i) => ({ jsonPath: `$.f${i}`, columnName: f })) }), master, allowSecrets)
  const link = db.prepare(`INSERT INTO http_column_associations (id,sheet_id,user_id,master_column_name,
    extracted_column_name,run_id) VALUES (?,?,?,?,?,?)`)
  for (const f of fields) link.run(uuid(), sid, uid, master, f, id)
}
const links = (sid: string, master: string) => db.prepare(`SELECT DISTINCT extracted_column_name FROM
  http_column_associations WHERE sheet_id = ? AND master_column_name = ? ORDER BY 1`).pluck().all(sid, master)
const newestHttp = (sid: string) => db.prepare(`SELECT * FROM http_runs WHERE sheet_id = ? ORDER BY rowid DESC
  LIMIT 1`).get(sid) as any
const save = (sid: string, name: string) => {
  const out = store.saveSetupVersion(sid, uid, { name })
  assert.ok('ok' in out, JSON.stringify(out))
  return out.ok.id
}
const restore = (sid: string, id: string, o: { dryRun?: boolean; secrets?: boolean } = {}) =>
  restoreSetupVersion(sid, uid, id, { dryRun: !!o.dryRun, hasSecretsScope: o.secrets ?? true, reveal: false })
const formula = (sid: string, column: string, f: string, inputs: string[]) =>
  db.prepare(`INSERT INTO formula_columns (id,user_id,sheet_id,column_name,formula,inputs,fill_status)
    VALUES (?,?,?,?,?,?,'done')`).run(uuid(), uid, sid, column, f, JSON.stringify(inputs))

await check('a field column that is a formula column now stays out of the restored HTTP column', async () => {
  const sid = sheet(['Name', 'Lookup', 'Post id', 'Title'])
  http(sid, 'Lookup', ['Post id', 'Title'])
  const v = save(sid, 'v')
  db.prepare("DELETE FROM http_column_associations WHERE sheet_id = ? AND extracted_column_name = 'Post id'").run(sid)
  formula(sid, 'Post id', '1', [])
  http(sid, 'Lookup', ['Title'])
  db.prepare(`UPDATE http_runs SET config = json_set(config, '$.requestConfig.url', 'https://example.com/x')
    WHERE id = ?`).run(newestHttp(sid).id)
  const out = await restore(sid, v)
  assert.ok('ok' in out, JSON.stringify(out))
  const by = new Map(out.ok.columns.map(c => [c.column, c]))
  assert.equal(by.get('Post id')!.action, 'leave')
  assert.match(by.get('Lookup')!.note ?? '',
    /comes back without the field it put in "Post id" \("Post id" is a formula column now\)/)
  assert.deepEqual(JSON.parse(newestHttp(sid).config).responseMapping.map((m: any) => m.columnName), ['Title'])
  assert.deepEqual(links(sid, 'Lookup'), ['Title'])
})

await check('links narrow to what the restored setup picks; the column dropped keeps its values', async () => {
  const sid = sheet(['Name', 'Lookup', 'Post id'])
  http(sid, 'Lookup', ['Post id'])
  const v = save(sid, 'v')
  setOrder(sid, ['Name', 'Lookup', 'Post id', 'Title'])
  http(sid, 'Lookup', ['Post id', 'Title'])
  const out = await restore(sid, v)
  assert.ok('ok' in out, JSON.stringify(out))
  assert.deepEqual(links(sid, 'Lookup'), ['Post id'])
  const title = out.ok.columns.find(c => c.column === 'Title')!
  assert.equal(title.action, 'keep')
  assert.match(title.note ?? '', /"Lookup" won't fill it anymore/)
})

await check('an AI column whose output column is another kind now is left as it is', async () => {
  const sid = sheet(['Name', 'Fit (Status)', 'Score', 'Why'])
  db.prepare(`INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt,model,status,output_columns,status_column,
    web_search_engine_used, use_openrouter_web_search) VALUES (?,?,?,?,?,?,'completed',?,?,?,1)`).run(uuid(), sid, uid,
    'Fit (Status)', 'Rate /name', 'm', JSON.stringify([{ columnName: 'Score', type: 'number' },
      { columnName: 'Why', type: 'text' }]), 'Fit (Status)', 'exa')
  const v = save(sid, 'v')
  db.prepare("UPDATE ai_runs SET prompt = 'Rate /name again' WHERE sheet_id = ?").run(sid)
  const kept = await restore(sid, v, { dryRun: true })
  assert.ok('ok' in kept && kept.ok.columns.find(c => c.column === 'Fit (Status)')!.action === 'restore')
  // Restored when it can be: the engine its runs resolved comes back with it.
  assert.ok('ok' in await restore(sid, v))
  assert.equal(db.prepare(`SELECT web_search_engine_used FROM ai_runs WHERE sheet_id = ? ORDER BY rowid DESC
    LIMIT 1`).pluck().get(sid), 'exa')
  formula(sid, 'Why', '1', [])
  db.prepare("UPDATE ai_runs SET prompt = 'Something else' WHERE sheet_id = ?").run(sid)
  const out = await restore(sid, v, { dryRun: true })
  assert.ok('ok' in out)
  const fit = out.ok.columns.find(c => c.column === 'Fit (Status)')!
  assert.equal(fit.action, 'leave')
  assert.match(fit.note ?? '', /it fills "Why", which is a formula column now/)
})

await check("a caller without 'secrets' freezes saved keys off", async () => {
  const sid = sheet(['Name', 'Lookup', 'Post id'])
  http(sid, 'Lookup', ['Post id'])
  const v = save(sid, 'v')
  db.prepare(`UPDATE http_runs SET config = json_set(config, '$.requestConfig.url', 'https://example.com/x')
    WHERE sheet_id = ?`).run(sid)
  assert.ok('ok' in await restore(sid, v, { secrets: false }))
  assert.equal(newestHttp(sid).allow_secrets, 0)
})

await check('a full sheet never drops the version being restored; it refuses instead', async () => {
  const sid = sheet(['Name', 'Notes'])
  const v = save(sid, 'kept copy')
  db.prepare('UPDATE setup_versions SET auto = 1 WHERE id = ?').run(v)
  for (let i = 1; i < MAX_SETUP_VERSIONS_PER_SHEET; i++) save(sid, `v${i}`)
  writeColumnDescription(sid, uid, 'Notes', 'changed')
  const dry = await restore(sid, v, { dryRun: true })
  assert.ok('ok' in dry && /keeps at most/.test(dry.ok.blocked ?? ''), JSON.stringify(dry))
  const out = await restore(sid, v)
  assert.ok('fail' in out && out.fail === 'conflict')
  assert.ok(!('fail' in store.readSetupVersion(sid, uid, v)))
})

await check('a loop is told by the dry run, and nothing is written', async () => {
  const sid = sheet(['A', 'B'])
  formula(sid, 'B', '{{A}}', ['A'])
  const v = save(sid, 'v')
  db.prepare("DELETE FROM formula_columns WHERE sheet_id = ? AND column_name = 'B'").run(sid)
  // B goes, a formula A reading B comes in: the version's B reading A would close a loop.
  setOrder(sid, ['A'])
  formula(sid, 'A', '{{B}}', ['B'])
  const dry = await restore(sid, v, { dryRun: true })
  assert.ok('ok' in dry && /work "B" out from itself/.test(dry.ok.blocked ?? ''), JSON.stringify(dry))
  const out = await restore(sid, v)
  assert.ok('fail' in out && out.fail === 'conflict')
  const order = db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck().get(sid) as string
  assert.deepEqual(JSON.parse(order), ['A'])
})

await check('only a column left as it is: nothing can be restored, its description untouched', async () => {
  const sid = sheet(['Name', 'Domain'])
  formula(sid, 'Domain', '{{Name}}', ['Name'])
  writeColumnDescription(sid, uid, 'Domain', 'from the name')
  const v = save(sid, 'v')
  db.prepare("DELETE FROM formula_columns WHERE sheet_id = ?").run(sid)
  writeColumnDescription(sid, uid, 'Domain', 'typed by hand now')
  const out = await restore(sid, v)
  assert.ok('ok' in out && out.ok.nothing, JSON.stringify(out))
  assert.match(out.ok.message, /^Nothing can be restored/)
  assert.equal(db.prepare(`SELECT description FROM column_descriptions WHERE sheet_id = ?`).pluck().get(sid),
    'typed by hand now')
})

if (failures) { console.error(`${failures} failed`); process.exit(1) }
console.log('setup-versions-edges: all passed')
