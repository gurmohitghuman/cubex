// A restored column's AI or HTTP setup never takes back a column another setup fills now
// (services/trash-restore-column-owners.ts, the rule a setup version's restore follows: lib/setup-versions/own.ts).
// An HTTP API column comes back without those fields, an AI column without those outputs, and plain when none
// is left or its "(Data)" column is another's; a list enrichment whose sheet is gone comes back plain. Each
// taken column is listed in references_dropped with the setup that fills it now, and the rerun the answer
// suggests never marks it Processing. The job queue only records: no run goes out.
import assert from 'node:assert/strict'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
// Nothing listens here: the model list can't be read, so a rerun's model isn't checked (lib/ai-model-check.ts).
process.env.OPENROUTER_BASE_URL = 'http://127.0.0.1:9/api/v1'
const { columnTrashKit } = await import('./column-trash-kit')
const { writeAiSetup, writeHttpSetup } = await import('../../server/src/services/setup-version-write')
const { appendColumnsToOrder } = await import('../../server/src/lib/sheet-columns')
const { rerunAiRunById, rerunHttpRunById } = await import('../../server/src/services/run-rerun-by-id')
const { sheetBusyWith } = await import('../../server/src/lib/sheet-busy')
const { trashSheet } = await import('../../server/src/services/trash-sheets')
type AiFill = import('../../server/src/lib/setup-versions/spec').AiFill
type HttpFill = import('../../server/src/lib/setup-versions/spec').HttpFill
const k = columnTrashKit('column-trash-owners')
const { db, uid, tid, ok, done, idle, sheet, order, cells, restoreOne, history } = k

const PROCESSING = '⏳ Processing...'
const ai = (outputs: string[], more: Partial<AiFill> = {}): AiFill => ({ kind: 'ai', prompt: 'About /Name',
  systemPrompt: null, model: 'vendor/model-x', temperature: null, maxChars: null, concurrency: null, webSearch: false,
  webFetch: false, outputColumns: outputs.length
    ? outputs.map(c => ({ columnName: c, type: 'string' as const, description: c })) : null,
  dataColumn: null, searchEngine: null, searchMode: null, maxSearchesPerRow: null, searchEngineUsed: null,
  runIf: null, ...more })
const http = (fields: Array<[string, string]>, destSheetId: string | null = null): HttpFill => ({ kind: 'http',
  mode: 'http', config: { requestConfig: { method: 'GET', url: 'https://api.example.test/p?n={{Name}}', headers: {} },
    responseMapping: fields.map(([jsonPath, columnName]) => ({ jsonPath, columnName })) },
  allowSecrets: 0, destSheetId, extracted: fields.map(f => f[1]) })
const setUp = (sid: string, column: string, f: AiFill | HttpFill) => db.transaction(() => {
  appendColumnsToOrder(sid, uid, [column])
  if (f.kind === 'ai') writeAiSetup(sid, uid, column, f)
  else writeHttpSetup(sid, uid, column, f, order(sid), true)
}).immediate()
const linked = (sid: string, master: string) => db.prepare(`SELECT extracted_column_name FROM
  http_column_associations WHERE sheet_id = ? AND master_column_name = ? ORDER BY 1`).pluck().all(sid, master)
const runOf = (table: 'ai_runs' | 'http_runs', id: string) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`)
  .get(id) as Record<string, any>
// Until the sheet is free, the cell never shows Processing; then what it holds.
const watched = async (sid: string, column: string, row = 0) => {
  for (let i = 0; i < 400 && (i < 3 || sheetBusyWith(sid)); i++) {
    assert.notEqual(cells(sid, column)[row], PROCESSING, `${column} was marked Processing`)
    await new Promise(r => setTimeout(r, 5))
  }
  await idle(sid)
  return cells(sid, column)[row]
}

await ok('an HTTP column whose field another setup fills now comes back without it; its rerun leaves it', async () => {
  const sid = sheet(['Name', 'Title', 'City'], [{ Name: 'Ann', Title: 'CEO' }, { Name: 'Bo', Title: 'CTO' }])
  setUp(sid, 'Fetch', http([['$.title', 'Title'], ['$.city', 'City']]))
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Fetch', '✅ Success', '$.City', 'Oslo') WHERE sheet_id = ?`)
    .run(sid)
  assert.deepEqual(linked(sid, 'Fetch'), ['City', 'Title'])
  const id = (await k.del(sid, 'Fetch'))!
  setUp(sid, 'Enrich', ai(['Title']))
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Title', 'paid AI answer') WHERE id = ?`).run(`r0-${sid}`)
  const got = (await restoreOne(id, { surface: 'rest', hasSecretsScope: true })).restored as any
  const run = runOf('http_runs', got.setup.run_id)
  assert.deepEqual(JSON.parse(run.config).responseMapping, [{ jsonPath: '$.city', columnName: 'City' }])
  assert.deepEqual(linked(sid, 'Fetch'), ['City'], 'Title is not linked to Fetch again')
  assert.deepEqual(got.setup, { kind: 'http', restored: true, run_id: run.id, note: 'Set up as it was (its '
    + 'newest run\'s settings), without the field it put in "Title" ("Title" is filled by "Enrich" now: it stays '
    + 'with that setup). Nothing ran and auto-run stays off: POST /api/v1/http-runs/' + run.id + '/rerun with a '
    + 'mode ("empty" for the rows it left empty) fills it.' })
  assert.deepEqual(got.references_dropped, [{ kind: 'output_taken', column: 'Title', mode: 'http', path: '$.title',
    owner: 'Enrich', owner_kind: 'an AI column', now: 'is filled by "Enrich" now', where: 'column "Title"',
    did: '"Fetch" wrote its field $.title here. "Title" is filled by "Enrich" now, so it stays with that setup and '
      + '"Fetch" came back without it',
    redo: `POST /api/v1/sheets/${sid}/http-runs for "Fetch", writing its field $.title into "Title", once nothing `
      + 'else fills "Title"' }])
  const detail = JSON.parse(history(sid).at(-1)!.detail!)
  assert.deepEqual(detail.setup, { kind: 'http', restored: true })
  assert.deepEqual(detail.references_dropped.map((r: any) => r.where), ['column "Title"'])
  const rerun = await rerunHttpRunById(uid, run.id, { mode: 'all', hasSecretsScope: true })
  assert.ok('ok' in rerun, JSON.stringify(rerun))
  assert.equal(await watched(sid, 'Title'), 'paid AI answer', 'the paid AI answer stays')
  assert.deepEqual([cells(sid, 'Fetch')[0], cells(sid, 'City')[0]], [PROCESSING, PROCESSING], 'its own still run')
})

await ok('an AI column whose output another setup fills now comes back without it; its rerun leaves it', async () => {
  const sid = sheet(['Name', 'Title', 'Summary'], [{ Name: 'Ann', Title: 'CEO', Summary: 'runs Acme' }])
  setUp(sid, 'Enrich', ai(['Title', 'Summary']))
  const id = (await k.del(sid, 'Enrich'))!
  setUp(sid, 'Fetch', http([['$.title', 'Title']]))
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Title', 'paid API answer') WHERE id = ?`).run(`r0-${sid}`)
  const got = (await restoreOne(id)).restored as any
  const run = runOf('ai_runs', got.setup.run_id)
  assert.deepEqual(JSON.parse(run.output_columns).map((o: any) => o.columnName), ['Summary'])
  assert.equal(got.setup.note, 'Set up as it was (its newest run\'s settings), without the output "Title" ("Title" '
    + 'is filled by "Fetch" now: it stays with that setup). Nothing ran and auto-run stays off: control_run with '
    + `action "rerun", run_type "ai", run_id "${run.id}" and a mode ("empty" for the rows it left empty) fills it.`)
  assert.deepEqual(got.references_dropped.map((r: any) => [r.kind, r.column, r.mode, r.owner, r.owner_kind, r.redo]),
    [['output_taken', 'Title', 'ai', 'Fetch', 'an HTTP API column', 'run_ai_column on "Enrich" with "Title" in '
      + 'output_columns, once nothing else fills "Title"']])
  assert.deepEqual(linked(sid, 'Fetch'), ['Title'], 'Fetch keeps it')
  const rerun = await rerunAiRunById(uid, run.id, { mode: 'all' })
  assert.ok('ok' in rerun, JSON.stringify(rerun))
  assert.equal(await watched(sid, 'Title'), 'paid API answer')
  assert.equal(cells(sid, 'Summary')[0], PROCESSING, 'its own output still runs')
})

await ok('an AI column with none of its outputs left, or its "(Data)" column taken, comes back plain', async () => {
  const sid = sheet(['Name', 'Title'], [{ Name: 'Ann', Title: 'CEO' }])
  setUp(sid, 'Enrich', ai(['Title']))
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Enrich', '✅') WHERE sheet_id = ?`).run(sid)
  const id = (await k.del(sid, 'Enrich'))!
  setUp(sid, 'Fetch', http([['$.title', 'Title']]))
  const got = (await restoreOne(id)).restored as any
  assert.deepEqual(got.setup, { kind: 'ai', restored: false, run_id: null, note: "Its setup wasn't restored: every "
    + 'column it puts its answers in is another setup\'s now: "Title" is filled by "Fetch" now. It came back as a '
    + 'plain column holding its cells. Set it up again.' })
  assert.deepEqual(got.references_dropped.map((r: any) => [r.column, r.owner]), [['Title', 'Fetch']])
  assert.equal(db.prepare(`SELECT COUNT(*) FROM ai_runs WHERE sheet_id = ? AND column_name = 'Enrich'`).pluck()
    .get(sid), 0)
  assert.deepEqual(cells(sid, 'Enrich'), ['✅'], 'its cells still come back')
  assert.deepEqual(JSON.parse(history(sid).at(-1)!.detail!).setup, { kind: 'ai', restored: false,
    why: 'every column it puts its answers in is another setup\'s now: "Title" is filled by "Fetch" now' })

  const web = sheet(['Name'], [{ Name: 'Ann' }])
  setUp(web, 'Pitch', ai([], { webSearch: true }))
  appendColumnsToOrder(web, uid, ['Pitch (Data)'])
  const pitch = (await k.del(web, 'Pitch'))!
  setUp(web, 'Src', http([['$.sources', 'Pitch (Data)']]))
  const plain = (await restoreOne(pitch)).restored as any
  assert.equal(plain.setup.note, 'Its setup wasn\'t restored: its web sources go to "Pitch (Data)", which is '
    + 'filled by "Src" now. It came back as a plain column holding its cells. Set it up again.')
  assert.deepEqual(plain.references_dropped.map((r: any) => [r.column, r.owner]), [['Pitch (Data)', 'Src']])
})

await ok('a column it wrote that is plain now, or gone, is its own again', async () => {
  const sid = sheet(['Name', 'Title', 'City'], [{ Name: 'Ann', Title: 'CEO', City: 'Oslo' }])
  setUp(sid, 'Fetch', http([['$.title', 'Title'], ['$.city', 'City']]))
  const id = (await k.del(sid, 'Fetch'))!
  await k.del(sid, 'City')
  const got = (await restoreOne(id)).restored as any
  assert.equal(got.setup.restored, true)
  assert.deepEqual(got.references_dropped, [])
  assert.deepEqual(JSON.parse(runOf('http_runs', got.setup.run_id).config).responseMapping.map((m: any) =>
    m.columnName), ['Title', 'City'], 'a field whose column is gone stays: its run adds the column again')
  assert.deepEqual(linked(sid, 'Fetch'), ['Title'])
})

await ok('a list enrichment whose sheet is gone comes back plain, and says why', async () => {
  const leads = sheet(['Name'], [{ Name: 'Ann' }], 'Leads list')
  const sid = sheet(['Name'], [{ Name: 'Acme' }])
  setUp(sid, 'People', http([], leads))
  db.prepare(`UPDATE rows SET data = json_set(data, '$.People', '✅ 3 rows') WHERE sheet_id = ?`).run(sid)
  const id = (await k.del(sid, 'People'))!
  assert.ok('ok' in trashSheet(uid, tid, leads))
  const got = (await restoreOne(id)).restored as any
  assert.deepEqual(got.setup, { kind: 'http', restored: false, run_id: null, note: "Its setup wasn't restored: "
    + 'the sheet it adds rows to is gone (deleted or in the trash). It came back as a plain column holding its '
    + 'cells. Set it up again.' })
  assert.equal(db.prepare(`SELECT COUNT(*) FROM http_runs WHERE sheet_id = ? AND master_column_name = 'People'`)
    .pluck().get(sid), 0)
  assert.deepEqual(cells(sid, 'People'), ['✅ 3 rows'])
})

done()
