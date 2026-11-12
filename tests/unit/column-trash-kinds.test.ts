// Over 200 lines: each kind of setup deleted and restored, same name and renamed, in one loop.
// A deleted column's own setup comes back with it (services/trash-restore-column-setup.ts), under its name or
// "<name> (restored)": an AI or HTTP API column as its newest run had it (a run record that ran nothing), and a
// rerun of it starts from those settings; a clean, formula or lookup column with its record, its rows worked
// out again by a fill as when it was made. Auto-run comes back off for every kind (and is listed as dropped
// when it was on). A setup that can't work now isn't written and says why; an HTTP request reading saved keys
// needs the secrets scope.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
// Nothing listens here: the model list can't be read, so a rerun's model isn't checked (lib/ai-model-check.ts).
process.env.OPENROUTER_BASE_URL = 'http://127.0.0.1:9/api/v1'
const { columnTrashKit } = await import('./column-trash-kit')
const { writeAiSetup, writeHttpSetup } = await import('../../server/src/services/setup-version-write')
const { appendColumnsToOrder } = await import('../../server/src/lib/sheet-columns')
const { rerunAiColumn } = await import('../../server/src/services/ai-run-rerun')
const { rerunHttpColumn } = await import('../../server/src/services/http-run-rerun')
const { startFormulaColumn } = await import('../../server/src/services/formula-column')
const { startCleanColumn } = await import('../../server/src/services/clean-column')
const { startLookupColumn } = await import('../../server/src/services/lookup-column')
const { encrypt } = await import('../../server/src/lib/crypto')
const { deleteRowsToTrash } = await import('../../server/src/services/trash-rows')
const k = columnTrashKit('column-trash-kinds')
const { db, uid, ok, done, idle, sheet, order, cells, del, restore, restoreOne, enqueued } = k

const people = () => sheet(['Email', 'Name'], [{ Email: 'Ann@Acme.com', Name: 'Ann' },
  { Email: 'bo@beta.io', Name: 'Bo' }, { Email: 'cy@acme.com', Name: 'Cy' }])
// A column of that name taken meanwhile, for the renamed case.
const take = (sid: string, name: string) => appendColumnsToOrder(sid, uid, [name])
const newest = (table: string, col: string, column: string, sid: string) => db.prepare(`SELECT * FROM ${table}
  WHERE sheet_id = ? AND ${col} = ? ORDER BY rowid DESC LIMIT 1`).get(sid, column) as Record<string, any>
const autorunOf = (sid: string, column: string) => db.prepare(`SELECT enabled FROM autorun_columns
  WHERE sheet_id = ? AND status_column = ?`).pluck().get(sid, column) as number | undefined
const filled = async (table: string, sid: string, column: string) => {
  for (let i = 0; i < 500; i++) {
    const s = db.prepare(`SELECT fill_status FROM ${table} WHERE sheet_id = ? AND column_name = ?`).pluck()
      .get(sid, column)
    if (s !== 'filling') return s
    await new Promise(r => setTimeout(r, 10))
  }
  return 'filling'
}

for (const renamed of [false, true]) {
  const as = (n: string) => (renamed ? `${n} (restored)` : n)
  const tag = renamed ? ' (renamed)' : ''

  await ok(`an AI column comes back set up as it was, and its rerun starts from it${tag}`, async () => {
    const sid = people()
    db.transaction(() => {
      appendColumnsToOrder(sid, uid, ['Pitch'])
      writeAiSetup(sid, uid, 'Pitch', { kind: 'ai', prompt: 'Write a line for /Name at /Email',
        systemPrompt: 'Be brief', model: 'openai/gpt-x', temperature: 0.3, maxChars: 200, concurrency: 7,
        webSearch: false, webFetch: false,
        outputColumns: null, dataColumn: null, searchEngine: null, searchMode: null, maxSearchesPerRow: null,
        searchEngineUsed: null, runIf: null })
    }).immediate()
    db.prepare(`UPDATE rows SET data = json_set(data, '$.Pitch', 'hi ' || json_extract(data, '$.Name'))
      WHERE sheet_id = ?`).run(sid)
    const id = (await del(sid, 'Pitch'))!
    if (renamed) take(sid, 'Pitch')
    const got = (await restoreOne(id)).restored as any
    assert.equal(got.name, as('Pitch'))
    const run = newest('ai_runs', 'column_name', as('Pitch'), sid)
    assert.deepEqual([run.prompt, run.system_prompt, run.model, run.temperature, run.max_chars, run.concurrency,
      run.status, run.setup_only], ['Write a line for /Name at /Email', 'Be brief', 'openai/gpt-x', 0.3, 200, 7,
      'completed', 1])
    assert.deepEqual(got.setup, { kind: 'ai', restored: true, run_id: run.id, note: 'Set up as it was (its newest '
      + `run's settings). Nothing ran and auto-run stays off: control_run with action "rerun", run_type "ai", run_id `
      + `"${run.id}" and a mode ("empty" for the rows it left empty) fills it.` })
    assert.deepEqual(cells(sid, as('Pitch')), ['hi Ann', 'hi Bo', 'hi Cy'])
    enqueued.length = 0
    const rerun = await rerunAiColumn(uid, { sheetId: sid, baseColumnName: as('Pitch'), columnName: as('Pitch'),
      mode: 'all' })
    assert.ok('ok' in rerun, JSON.stringify(rerun))
    assert.equal(rerun.ok.targetCount, 3)
    const started = db.prepare('SELECT * FROM ai_runs WHERE id = ?').get(rerun.ok.runId) as Record<string, any>
    assert.deepEqual([started.column_name, started.prompt, started.model, started.setup_only],
      [as('Pitch'), 'Write a line for /Name at /Email', 'openai/gpt-x', 0])
    assert.ok(enqueued.some(j => j.args[0] === rerun.ok.runId), 'its job was queued')
    await idle(sid)
  })

  await ok(`an HTTP API column comes back with its request and fields, and its rerun starts from it${tag}`,
    async () => {
      const sid = people()
      const config = { requestConfig: { method: 'GET', url: 'https://api.example.test/p?e={{Email}}', headers: {} },
        responseMapping: [{ jsonPath: '$.title', columnName: 'Title' }], batchSize: 5 }
      db.transaction(() => {
        appendColumnsToOrder(sid, uid, ['Lookup', 'Title'])
        writeHttpSetup(sid, uid, 'Lookup', { kind: 'http', mode: 'http', config, allowSecrets: 1, destSheetId: null,
          extracted: ['Title'] }, order(sid), true)
      }).immediate()
      db.prepare(`UPDATE rows SET data = json_set(data, '$.Lookup', '✅', '$.Title', 'CEO') WHERE sheet_id = ?`).run(sid)
      const id = (await del(sid, 'Lookup'))!
      if (renamed) take(sid, 'Lookup')
      const got = (await restoreOne(id, { surface: 'rest', hasSecretsScope: false })).restored as any
      assert.equal(got.name, as('Lookup'))
      const run = newest('http_runs', 'master_column_name', as('Lookup'), sid)
      assert.deepEqual(JSON.parse(run.config), config)
      assert.equal(run.setup_only, 1)
      assert.deepEqual(db.prepare(`SELECT extracted_column_name FROM http_column_associations WHERE sheet_id = ?
        AND master_column_name = ?`).pluck().all(sid, as('Lookup')), ['Title'], 'its field is its own again')
      assert.equal(got.setup.note, 'Set up as it was (its newest run\'s settings). Nothing ran and auto-run stays off: '
        + `POST /api/v1/http-runs/${run.id}/rerun with a mode ("empty" for the rows it left empty) fills it.`)
      enqueued.length = 0
      const rerun = await rerunHttpColumn(uid, { sheetId: sid, masterColumnName: as('Lookup') })
      assert.ok('ok' in rerun, JSON.stringify(rerun))
      assert.equal(rerun.ok.targetCount, 3)
      const started = db.prepare('SELECT config, setup_only FROM http_runs WHERE id = ?').get(rerun.ok.runId) as
        { config: string; setup_only: number }
      assert.equal(JSON.parse(started.config).requestConfig.url, config.requestConfig.url)
      assert.equal(started.setup_only, 0)
      assert.ok(enqueued.length > 0, 'its job was queued')
      await idle(sid)
    })

  await ok(`a formula column comes back and works its rows out again, auto-run off${tag}`, async () => {
    const sid = people()
    const made = await startFormulaColumn(uid, sid, { column: 'Domain', formula: '{{Email}}.split("@")[1]' })
    assert.ok('ok' in made, JSON.stringify(made))
    await idle(sid)
    assert.equal(autorunOf(sid, 'Domain'), 1)
    const id = (await del(sid, 'Domain'))!
    db.prepare(`UPDATE rows SET data = json_set(data, '$.Email', 'zed@zeta.org') WHERE id = ?`).run(`r1-${sid}`)
    if (renamed) take(sid, 'Domain')
    const got = (await restoreOne(id)).restored as any
    assert.equal(got.setup.note, 'Set up as it was. Its rows are being worked out again now, in the background, as '
      + 'when it was made; auto-run stays off.')
    assert.deepEqual(got.references_dropped.map((r: any) => r.kind), ['auto_run'])
    assert.equal(got.references_dropped[0].redo, `set_auto_run on "${as('Domain')}"`)
    assert.equal(await filled('formula_columns', sid, as('Domain')), 'done')
    await idle(sid)
    assert.deepEqual(cells(sid, as('Domain')), ['Acme.com', 'zeta.org', 'acme.com'], 'worked out again from now')
    assert.ok(!autorunOf(sid, as('Domain')))
  })

  await ok(`a clean column comes back and cleans its rows again, auto-run off${tag}`, async () => {
    const sid = people()
    const made = await startCleanColumn(uid, sid, { source: 'Email', cleaner: 'email', column: 'Clean email' })
    assert.ok('ok' in made, JSON.stringify(made))
    await idle(sid)
    const id = (await del(sid, 'Clean email'))!
    if (renamed) take(sid, 'Clean email')
    const got = (await restoreOne(id)).restored as any
    assert.equal(got.setup.kind, 'clean')
    assert.equal(got.setup.restored, true)
    const rec = newest('clean_columns', 'column_name', as('Clean email'), sid)
    assert.deepEqual([rec.source_column, rec.cleaner], ['Email', 'email'])
    assert.equal(await filled('clean_columns', sid, as('Clean email')), 'done')
    await idle(sid)
    assert.deepEqual(cells(sid, as('Clean email')), ['ann@acme.com', 'bo@beta.io', 'cy@acme.com'])
    assert.ok(!autorunOf(sid, as('Clean email')))
  })

  await ok(`a lookup column comes back and looks its rows up again${tag}`, async () => {
    const accounts = sheet(['Domain', 'Owner'], [{ Domain: 'acme.com', Owner: 'Kim' },
      { Domain: 'beta.io', Owner: 'Lee' }])
    const sid = sheet(['Domain', 'Name'], [{ Domain: 'beta.io', Name: 'x' }, { Domain: 'acme.com', Name: 'y' }])
    const made = await startLookupColumn(uid, sid, { column: 'Owner', sourceColumn: 'Domain', otherSheetId: accounts,
      matchColumn: 'Domain', returns: 'value', returnColumn: 'Owner' })
    assert.ok('ok' in made, JSON.stringify(made))
    assert.equal(await filled('lookup_columns', sid, 'Owner'), 'done')
    await idle(sid)
    const id = (await del(sid, 'Owner'))!
    db.prepare(`UPDATE rows SET data = json_set(data, '$.Owner', 'Max') WHERE id = ?`).run(`r1-${accounts}`)
    if (renamed) take(sid, 'Owner')
    const got = (await restoreOne(id)).restored as any
    assert.equal(got.setup.kind, 'lookup')
    assert.equal(got.setup.restored, true)
    assert.equal(await filled('lookup_columns', sid, as('Owner')), 'done')
    await idle(sid)
    assert.deepEqual(cells(sid, as('Owner')), ['Max', 'Kim'], 'looked up again in the other sheet as it is now')
  })
}

await ok('restored with rows of its sheet in one request, a formula column fills after the request', async () => {
  const sid = people()
  assert.ok('ok' in await startFormulaColumn(uid, sid, { column: 'Domain', formula: '{{Email}}.split("@")[1]' }))
  await idle(sid)
  const rows = db.transaction(() => deleteRowsToTrash(sid, uid, 'grid', { indexes: [2] })).immediate().trashId!
  const id = (await del(sid, 'Domain'))!
  const results = await restore([rows, id])
  assert.deepEqual(results.map(r => r.trash_id), [id, rows])
  assert.ok(results.every(r => r.restored), `nothing refused as busy: ${JSON.stringify(results)}`)
  assert.equal(await filled('formula_columns', sid, 'Domain'), 'done')
  await idle(sid)
  assert.deepEqual(cells(sid, 'Domain'), ['Acme.com', 'beta.io', 'acme.com'])
})

await ok('a restore whose last transaction failed once is tried again, and its fill still starts', async () => {
  const sid = people()
  assert.ok('ok' in await startFormulaColumn(uid, sid, { column: 'User', formula: '{{Email}}.split("@")[0]' }))
  await idle(sid)
  const id = (await del(sid, 'User'))!
  db.prepare(`UPDATE rows SET data = json_set(data, '$.Email', 'zed@zeta.org') WHERE id = ?`).run(`r0-${sid}`)
  const prepare = db.prepare.bind(db)
  let failOnce = true
  ;(db as any).prepare = (sql: string) => {
    if (failOnce && sql === 'DELETE FROM trash_items WHERE id = ?') { failOnce = false; throw new Error('disk hiccup') }
    return prepare(sql)
  }
  try {
    await assert.rejects(restoreOne(id), /disk hiccup/)
  } finally { (db as any).prepare = prepare }
  assert.equal(k.item(id)!.state, 'restoring', 'its cells went back: it goes on, not back to the trash')
  for (let i = 0; i < 600 && k.item(id); i++) await new Promise(r => setTimeout(r, 10))
  assert.equal(k.item(id), undefined, 'tried again')
  assert.equal(await filled('formula_columns', sid, 'User'), 'done')
  await idle(sid)
  assert.deepEqual(cells(sid, 'User'), ['zed', 'bo', 'cy'], 'worked out again')
})

await ok("a setup that can't work now isn't written: the column comes back plain and says why", async () => {
  const sid = people()
  const made = await startFormulaColumn(uid, sid, { column: 'First', formula: '{{Name}}.slice(0, 1)' })
  assert.ok('ok' in made)
  await idle(sid)
  const id = (await del(sid, 'First'))!
  await del(sid, 'Name')
  const got = (await restoreOne(id)).restored as any
  assert.deepEqual(got.setup, { kind: 'formula', restored: false, run_id: null, note: "Its setup wasn't restored: "
    + 'its formula no longer reads: There\'s no column named "Name". It came back as a plain column holding its '
    + 'cells. Set it up again with formula_column.' })
  assert.deepEqual(cells(sid, 'First'), ['A', 'B', 'C'])
  assert.equal(db.prepare('SELECT COUNT(*) FROM formula_columns WHERE sheet_id = ? AND column_name = ?').pluck()
    .get(sid, 'First'), 0)
})

await ok("an HTTP request reading a saved key needs the secrets scope to come back", async () => {
  const sid = people()
  db.prepare(`INSERT INTO api_keys (id, user_id, name, key_type, key_value_encrypted) VALUES (?,?,'Crm','custom',?)`)
    .run(uuid(), uid, encrypt('k-123'))
  const config = { requestConfig: { method: 'GET', url: 'https://api.example.test/p?e={{Email}}',
    headers: { Authorization: 'Bearer {{Crm}}' } }, responseMapping: [] }
  db.transaction(() => {
    appendColumnsToOrder(sid, uid, ['Sync'])
    writeHttpSetup(sid, uid, 'Sync', { kind: 'http', mode: 'http', config, allowSecrets: 1, destSheetId: null,
      extracted: [] }, order(sid), true)
  }).immediate()
  const id = (await del(sid, 'Sync'))!
  const refused = await restoreOne(id, { surface: 'mcp', hasSecretsScope: false })
  assert.deepEqual([refused.fail, refused.error], ['forbidden',
    "\"Sync\": A request it puts back reads saved API keys: restoring it needs the 'secrets' scope."])
  const got = (await restoreOne(id, { surface: 'mcp', hasSecretsScope: true })).restored as any
  assert.equal(newest('http_runs', 'master_column_name', 'Sync', sid).allow_secrets, 1)
  assert.equal(got.setup.restored, true)
})

done()
