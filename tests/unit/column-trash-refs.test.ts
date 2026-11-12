// What referred to a deleted column is cleaned up as before, and the restore lists each reference that didn't
// come back (lib/trash/column-refs.ts, column-refs-words.ts): a column "Email" named by a view's hidden columns
// and its filter, the sheet's filter, another column's HTTP field, a list enrichment in another sheet, a
// structured AI run's output, a formula's auto-run reading it, lookups in other sheets (matching it, returning
// it), a webhook mapping, auto-dedupe and a run's undo; its own auto-run (a formula column); and an AI run's
// "(Data)" column. Another column's auto-run waiting for it lifts by itself when it is back under its name, so
// it is listed only when the name changed.
import assert from 'node:assert/strict'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
process.env.OPENROUTER_BASE_URL = 'http://127.0.0.1:9/api/v1'
const { columnTrashKit } = await import('./column-trash-kit')
const { writeAiSetup, writeHttpSetup } = await import('../../server/src/services/setup-version-write')
const { appendColumnsToOrder } = await import('../../server/src/lib/sheet-columns')
const { createView, saveRowFilter } = await import('../../server/src/services/views')
const { createSourceWithColumn } = await import('../../server/src/lib/webhook-service')
const { addWebhookMapping } = await import('../../server/src/services/webhook-mapping-add')
const { startFormulaColumn } = await import('../../server/src/services/formula-column')
const { startLookupColumn } = await import('../../server/src/services/lookup-column')
const { setAutoDedupe } = await import('../../server/src/services/auto-dedupe-setting')
const { journalRowWrite } = await import('../../server/src/lib/run-undo/journal')
const k = columnTrashKit('column-trash-refs')
const { db, uid, ok, done, idle, sheet, order, del, restoreOne } = k
const nameOf = (sid: string) => db.prepare('SELECT name FROM sheets WHERE id = ?').pluck().get(sid) as string
const no = (out: object) => assert.ok(!('fail' in out), JSON.stringify(out))

// Sheet A with "Email" named every way a delete cleans, and the other sheets naming it.
let round = 0
async function referenced() {
  const n = ++round === 1 ? '' : ` ${round}`
  // The webhook's mapping makes the Email column (its rows hold their emails already).
  const a = sheet(['Name'], [{ Email: 'ann@acme.com', Name: 'Ann' }, { Email: 'bo@beta.io', Name: 'Bo' }],
    `Leads${n}`)
  const hook = createSourceWithColumn(a, uid, 'Form').source
  no(addWebhookMapping(a, uid, hook.id, { jsonPath: '$.email', columnName: 'Email', valueMode: 'scalar' }))
  no(createView(a, uid, { name: 'Hot', hidden_columns: ['Email'] }))
  no(createView(a, uid, { name: 'Has email', where: [{ column: 'Email', operator: 'not_empty' }] }))
  no(saveRowFilter(a, uid, [{ column: 'Email', operator: 'contains', value: '@' }]))
  let enrich = ''
  db.transaction(() => {
    appendColumnsToOrder(a, uid, ['Enrich', 'Research'])
    enrich = writeHttpSetup(a, uid, 'Enrich', { kind: 'http', mode: 'http', destSheetId: null, allowSecrets: 1,
      extracted: ['Email'], config: { requestConfig: { method: 'GET', url: 'https://api.example.test/{{Name}}' },
        responseMapping: [{ jsonPath: '$.email', columnName: 'Email' }] } }, ['Email', 'Name', 'Enrich'], true)
    writeAiSetup(a, uid, 'Research', { kind: 'ai', prompt: 'About /Name', systemPrompt: null, model: 'm/x',
      temperature: null, maxChars: null, concurrency: null, webSearch: false, webFetch: false,
      outputColumns: [{ columnName: 'Email', type: 'text', description: 'their email' }], dataColumn: null,
      searchEngine: null, searchMode: null, maxSearchesPerRow: null, searchEngineUsed: null, runIf: null })
  }).immediate()
  const b = sheet(['Company'], [{ Company: 'Acme' }], `Accounts${n}`)
  db.transaction(() => {
    appendColumnsToOrder(b, uid, ['People'])
    writeHttpSetup(b, uid, 'People', { kind: 'http', mode: 'enrichment', destSheetId: a, allowSecrets: 1, extracted: [],
      config: { requestConfig: { method: 'POST', url: 'https://treg.example.test/x' }, responseMapping: [],
        enrichment: { toolId: 'people.list',
          list: { fields: [{ path: '$.email', columnName: 'Email' }], copy: [] } } } },
    ['Company', 'People'], true)
  }).immediate()
  no(await startFormulaColumn(uid, a, { column: 'Domain', formula: '{{Email}}.split("@")[1]' }))
  await idle(a)
  const c = sheet(['Key'], [{ Key: 'ann@acme.com' }], `Contacts${n}`)
  no(await startLookupColumn(uid, c, { column: 'Known', sourceColumn: 'Key', otherSheetId: a, matchColumn: 'Email',
    returns: 'exists' }))
  await idle(c)
  no(await startLookupColumn(uid, c, { column: 'Their email', sourceColumn: 'Key', otherSheetId: a,
    matchColumn: 'Name', returns: 'value', returnColumn: 'Email' }))
  await idle(c)
  no(setAutoDedupe(uid, a, { column: 'Email' }))
  db.transaction(() => journalRowWrite({ kind: 'http', id: enrich }, a, uid, 0, [['Email', 'x@y.co']], null))
    .immediate()
  await idle(a)
  return { a, b, c, hook: hook.name }
}

await ok('the delete records every reference it cleans, and still cleans each as before', async () => {
  const { a, b, c, hook } = await referenced()
  const id = (await del(a, 'Email'))!
  const refs = JSON.parse(k.item(id)!.column_dropped)
  const views = db.prepare('SELECT id, name FROM sheet_views WHERE sheet_id = ?').all(a) as Array<{ id: string;
    name: string }>
  const view = (n: string) => views.find(v => v.name === n)!.id
  assert.deepEqual(refs, [
    { kind: 'view_hidden', view_id: view('Hot'), view: 'Hot' },
    { kind: 'view_filter', view_id: view('Has email'), view: 'Has email' },
    { kind: 'sheet_filter' },
    { kind: 'http_field', column: 'Enrich', mode: 'http', path: '$.email' },
    { kind: 'list_field', sheet_id: b, sheet: 'Accounts', column: 'People' },
    { kind: 'ai_output', column: 'Research' },
    { kind: 'auto_run_input', column: 'Domain' },
    { kind: 'lookup_into', sheet_id: c, sheet: 'Contacts', column: 'Known', part: 'match' },
    { kind: 'lookup_into', sheet_id: c, sheet: 'Contacts', column: 'Their email', part: 'return' },
    { kind: 'webhook_mapping', webhook: hook, field: '$.email' },
    { kind: 'auto_dedupe', keep: 'oldest' },
    { kind: 'undo', runs: 1 },
  ])
  // Cleaned as before.
  const v = db.prepare('SELECT hidden_columns, row_filter FROM sheet_views WHERE sheet_id = ? ORDER BY position')
    .all(a) as Array<{ hidden_columns: string | null; row_filter: string | null }>
  assert.ok(v.every(x => !(x.hidden_columns ?? '').includes('Email') && !(x.row_filter ?? '').includes('Email')))
  assert.equal(db.prepare('SELECT row_filter FROM sheets WHERE id = ?').pluck().get(a), null)
  assert.equal(db.prepare('SELECT COUNT(*) FROM webhook_mappings WHERE column_name = ?').pluck().get('Email'), 0)
  assert.equal(db.prepare('SELECT COUNT(*) FROM auto_dedupe WHERE sheet_id = ?').pluck().get(a), 0)
  assert.equal(db.prepare(`SELECT COUNT(*) FROM http_column_associations WHERE sheet_id = ?
    AND extracted_column_name = 'Email'`).pluck().get(a), 0)
  assert.deepEqual(JSON.parse(db.prepare(`SELECT output_columns FROM ai_runs WHERE sheet_id = ?
    AND column_name = 'Research' ORDER BY rowid DESC`).pluck().get(a) as string), [])
  assert.deepEqual(db.prepare('SELECT broken FROM lookup_columns WHERE sheet_id = ? ORDER BY column_name').pluck()
    .all(c), ['The column "Email" in "Leads" was deleted.', 'The column "Email" in "Leads" was deleted.'])
  assert.equal(db.prepare(`SELECT paused_reason FROM autorun_columns WHERE sheet_id = ? AND status_column = 'Domain'`)
    .pluck().get(a), 'missing_input')
  const enrichRun = db.prepare(`SELECT id FROM http_runs WHERE sheet_id = ? AND master_column_name = 'Enrich'`)
    .pluck().get(a)
  assert.deepEqual(JSON.parse(db.prepare('SELECT columns FROM run_undos WHERE run_id = ?').pluck()
    .get(enrichRun) as string), [null])
  // Back under its name: each is listed, in MCP's words, but the formula's waiting auto-run (it lifts by itself).
  const got = (await restoreOne(id)).restored as any
  assert.equal(got.name, 'Email')
  const e = got.references_dropped as Array<Record<string, unknown>>
  assert.deepEqual(e.map(x => [x.kind, x.where, x.did, x.redo]), [
    ['view_hidden', 'view "Hot"', 'hid this column', 'manage_view with action "change", view "Hot" and "Email" in '
      + 'hidden_columns'],
    ['view_filter', 'view "Has email"', 'filtered rows on this column', 'manage_view with action "change", view '
      + '"Has email" and a where on "Email"'],
    ['sheet_filter', "the sheet's filter", 'filtered the rows the sheet shows on this column', 'Filter on it again in '
      + 'the app, or keep the filter in a view with manage_view'],
    ['http_field', 'column "Enrich"', 'the HTTP API column "Enrich" wrote its field $.email here',
      'run_http_enrichment on "Enrich", writing its field $.email into "Email"'],
    ['list_field', 'sheet "Accounts", column "People"', 'the list enrichment "People" in "Accounts" put one of its '
      + `fields in this column`, `add_list_rows (sheet ${b}, column "People") with a field into "Email"`],
    ['ai_output', 'column "Research"', 'the AI column "Research" wrote one of its outputs here',
      'run_ai_column on "Research" with "Email" in output_columns'],
    ['lookup_into', 'sheet "Contacts", column "Known"', 'the lookup column "Known" in "Contacts" matched rows on this '
      + 'column, and stopped', `lookup_column on the sheet ${c} to set "Known" up again with "Email"`],
    ['lookup_into', 'sheet "Contacts", column "Their email"', 'the lookup column "Their email" in "Contacts" returned '
      + 'this column, and stopped', `lookup_column on the sheet ${c} to set "Their email" up again with "Email"`],
    ['webhook_mapping', `webhook "${hook}"`, 'put the field $.email of each event in this column',
      "Map the field to it again in the sheet's webhook settings (only in the app)."],
    ['auto_dedupe', 'auto-dedupe', 'kept one row per value of this column (the oldest), and is off now',
      'set_auto_dedupe with column "Email"'],
    ['undo', 'undo_run', 'undoing the run that wrote this column no longer puts its cells back',
      'Nothing to set up: those undos leave this column as it is.'],
  ])
  // What doesn't come back stays as the delete left it; the formula's auto-run goes on once the sweep looks.
  assert.equal(db.prepare('SELECT COUNT(*) FROM webhook_mappings WHERE column_name = ?').pluck().get('Email'), 0)
  assert.equal(db.prepare('SELECT COUNT(*) FROM auto_dedupe WHERE sheet_id = ?').pluck().get(a), 0)
  assert.equal(db.prepare('SELECT COUNT(*) FROM lookup_columns WHERE sheet_id = ? AND broken IS NULL').pluck()
    .get(c), 0)
  assert.ok(order(a).includes('Email'))
  assert.equal(nameOf(a), 'Leads')
})

await ok('renamed, the auto-run waiting for the old name is listed too; REST names its routes', async () => {
  const { a } = await referenced()
  const id = (await del(a, 'Email'))!
  appendColumnsToOrder(a, uid, ['email'])
  const got = (await restoreOne(id, { surface: 'rest', hasSecretsScope: true })).restored as any
  assert.equal(got.name, 'Email (restored)')
  const wait = got.references_dropped.find((x: any) => x.kind === 'auto_run_input')
  assert.deepEqual([wait.where, wait.did, wait.redo], ['column "Domain"', 'the auto-run of "Domain" reads "Email", '
    + 'and waits until a column named "Email" is back', `PATCH /api/v1/sheets/${a}/columns/:name to rename "Email `
    + '(restored)" to "Email" once that name is free, or set "Domain" up to read "Email (restored)"'])
  assert.equal(got.references_dropped.length, 12)
  assert.equal(got.references_dropped[0].redo, `PATCH /api/v1/sheets/${a}/views/${got.references_dropped[0].view_id} `
    + 'with "Email (restored)" in hidden_columns')
})

await ok("its own auto-run, and an AI column's (Data) column (web search turned off with it)", async () => {
  const a = sheet(['Name'], [{ Name: 'Ann' }, { Name: 'Bo' }])
  no(await startFormulaColumn(uid, a, { column: 'Initial', formula: '{{Name}}.slice(0, 1)' }))
  await idle(a)
  const own = (await del(a, 'Initial'))!
  assert.deepEqual(JSON.parse(k.item(own)!.column_dropped), [{ kind: 'auto_run', type: 'formula' }])
  const got = (await restoreOne(own, { surface: 'app', hasSecretsScope: true })).restored as any
  assert.deepEqual(got.references_dropped.map((x: any) => [x.where, x.did, x.redo]), [['auto-run', 'ran this column '
    + 'on new and changed rows by itself (it is off now)', 'Turn auto-run on again from its column menu.']])
  await idle(a)   // its rows are worked out again first
  db.transaction(() => {
    appendColumnsToOrder(a, uid, ['Notes (Output)', 'Notes (Data)'])
    writeAiSetup(a, uid, 'Notes (Output)', { kind: 'ai', prompt: 'About /Name', systemPrompt: null, model: 'm/x',
      temperature: null, maxChars: null, concurrency: null, webSearch: true, webFetch: false, outputColumns: null,
      dataColumn: null, searchEngine: null, searchMode: null, maxSearchesPerRow: null, searchEngineUsed: null,
      runIf: null })
  }).immediate()
  const data = (await del(a, 'Notes (Data)'))!
  assert.deepEqual(JSON.parse(k.item(data)!.column_dropped), [{ kind: 'ai_data', column: 'Notes (Output)',
    search_off: true }])
  assert.equal(db.prepare(`SELECT use_openrouter_web_search FROM ai_runs WHERE sheet_id = ?
    AND column_name = 'Notes (Output)'`).pluck().get(a), 0, 'the delete turned web search off, as before')
  const back = (await restoreOne(data)).restored as any
  assert.deepEqual(back.references_dropped.map((x: any) => x.did), ['the AI column "Notes (Output)" wrote its web '
    + 'sources here (web search on it was turned off)'])
})

done()
