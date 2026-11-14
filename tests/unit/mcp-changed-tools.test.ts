// What a write changed (server/src/mcp/changed.ts): every tool that can write answers `changed` in its output
// schema, required and the one shared shape, or is in WITHOUT_CHANGED with its reason, never both and never
// neither; a read-only tool has neither. changedOf merges a sheet's touches, keeps the first 100 row ids and
// reads the sheet's versions after the write, leaving out a sheet that isn't the caller's. Then write tools
// through /mcp under the strict output check: what each names, [] for a dry run, a preview and a rename, and a
// replay answering the first call's. Last, the fields three answers had that their schemas didn't name, which
// the strict check refused: formula_column's description, auto_run_paused, error and stopped, create_sample's
// problems and a started run_ai_column's token_spend.
// Over 200 lines: one account's writes, each building on the last; split, each part would redo them.
import './strict-output'
import assert from 'node:assert/strict'
import dbMod from '../../server/src/lib/db'
import buildMod from '../../server/src/mcp/build-server'
import outputsMod from '../../server/src/mcp/tool-outputs'
import sharedMod from '../../server/src/mcp/outputs/shared'
import changedMod from '../../server/src/mcp/changed'
import sampleMod from '../../server/src/services/sample-answer'
import formulaViewMod from '../../server/src/services/formula-view'
import spendMod from '../../server/src/services/token-spend'
import { mcpHttpKit } from './mcp-http-kit'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { buildMcpServer } = buildMod as typeof import('../../server/src/mcp/build-server')
const { TOOL_OUTPUTS } = outputsMod as typeof import('../../server/src/mcp/tool-outputs')
const { changed: CHANGED, CHANGED_ROW_IDS } = sharedMod as typeof import('../../server/src/mcp/outputs/shared')
const { WITHOUT_CHANGED, changedOf } = changedMod as typeof import('../../server/src/mcp/changed')
const { sampleAnswer } = sampleMod as typeof import('../../server/src/services/sample-answer')
const { formulaColumnJson } = formulaViewMod as typeof import('../../server/src/services/formula-view')
const { spendPart } = spendMod as typeof import('../../server/src/services/token-spend')

const { ctx, check, done, crash, modern } = mcpHttpKit('mcp-changed-tools')
const u = ctx.userId
for (const scope of ['write', 'run'] as const) ctx.scopes.add(scope as never)

type Item = { sheet_id: string; sheet: string; columns: string[]; rows: number; row_ids?: string[];
  data_version: number; row_generation: number; more_coming?: true }
type Answer = Record<string, unknown> & { changed: Item[] }

async function call(name: string, args: Record<string, unknown>): Promise<Answer> {
  const res = await modern('tools/call', { name, arguments: args }, name)
  const result = JSON.parse(res.text).result
  assert.notEqual(result?.isError, true, `${name}: ${JSON.stringify(result)}`)
  return result.structuredContent as Answer
}
const versions = (sheet: string) => db.prepare('SELECT data_version, row_generation FROM sheets WHERE id = ?')
  .get(sheet) as { data_version: number; row_generation: number }

async function main() {
  await check('every write tool answers changed or is listed without it, never both; reads have neither', () => {
    const server = buildMcpServer({ userId: 'u', tokenId: 't', tokenName: 'n', scopes: new Set() })
    type Registered = Record<string, { annotations?: { readOnlyHint?: boolean } }>
    const tools = (server as unknown as { _registeredTools: Registered })._registeredTools
    const outputs = TOOL_OUTPUTS as Record<string, { shape: Record<string, unknown> }>
    let writers = 0
    for (const [name, tool] of Object.entries(tools)) {
      const answers = 'changed' in outputs[name].shape
      const listed = name in WITHOUT_CHANGED
      if (tool.annotations?.readOnlyHint) {
        assert.ok(!answers && !listed, `${name} is read-only: no changed, not listed`)
        continue
      }
      writers++
      assert.ok(answers !== listed,
        `${name} writes: it answers changed (${answers}) or is listed (${listed}), one of them`)
      if (answers) assert.equal(outputs[name].shape.changed, CHANGED, `${name}'s changed is the shared shape, required`)
    }
    for (const name of Object.keys(WITHOUT_CHANGED)) {
      assert.equal(tools[name]?.annotations?.readOnlyHint, false, `${name} in WITHOUT_CHANGED is a write tool`)
    }
    assert.ok(writers >= 40, `${writers} write tools`)
  })

  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run('other', 'x')
  db.prepare("INSERT INTO tables (id,user_id,name) VALUES ('ot','other','Theirs')").run()
  db.prepare(`INSERT INTO sheets (id,table_id,user_id,name,data_version,row_generation)
    VALUES ('os','ot','other','Theirs',4,2)`).run()

  await check('changedOf merges, keeps 100 row ids, reads versions, skips a sheet not the caller\'s', async () => {
    const t = await call('manage_table', { action: 'create', name: 'Merge' })
    const sheet = (t.sheets as Array<{ id: string }>)[0].id
    db.prepare('UPDATE sheets SET data_version = 7, row_generation = 3 WHERE id = ?').run(sheet)
    const ids = Array.from({ length: 120 }, (_, i) => `r${i}`)
    const out = changedOf(u, [
      { sheetId: sheet, columns: ['A', 'B'], rows: 60, rowIds: ids.slice(0, 60) }, null, false,
      { sheetId: 'os', columns: ['X'], rows: 1 },
      { sheetId: sheet, columns: ['B', 'C'], rows: 60, rowIds: ids.slice(60), moreComing: true },
      { sheetId: 'gone', rows: 1 },
    ])
    assert.deepEqual(out, [{ sheet_id: sheet, sheet: 'Sheet1', columns: ['A', 'B', 'C'], rows: 120,
      row_ids: ids.slice(0, CHANGED_ROW_IDS), data_version: 7, row_generation: 3, more_coming: true }])
    const bare = changedOf(u, [{ sheetId: sheet }])
    assert.deepEqual(bare.map(i => [i.columns, i.rows, 'row_ids' in i, 'more_coming' in i]),
      [[[], 0, false, false]], 'a touch with nothing named: no row_ids, no more_coming')
  })

  const made = await call('manage_table', { action: 'create', name: 'People' })
  const sheet = (made.sheets as Array<{ id: string }>)[0].id

  await check('a new table answers its sheet, empty', () => {
    assert.deepEqual(made.changed.map(i => [i.sheet_id, i.sheet, i.columns, i.rows]), [[sheet, 'Sheet1', [], 0]])
  })

  await check('add_column names the column, and the versions are the sheet\'s after it', async () => {
    const a = await call('add_column', { sheet_id: sheet, name: 'Email' })
    assert.deepEqual(a.changed.map(i => [i.columns, i.rows]), [[['Email'], 0]])
    assert.deepEqual({ data_version: a.changed[0].data_version, row_generation: a.changed[0].row_generation },
      versions(sheet))
    for (const name of ['Name', 'Title']) await call('add_column', { sheet_id: sheet, name })
  })

  let rowIds: string[] = []
  await check('append_rows names its columns and rows; a replay of its key answers the same', async () => {
    const before = versions(sheet).data_version
    const rows = [{ Email: 'a@x.com', Name: 'Ann' }, { Email: 'b@x.com' }, { Email: 'a@x.com', Name: 'Ann' }]
    const a = await call('append_rows', { sheet_id: sheet, rows, idempotency_key: 'k1' })
    rowIds = (a.rows as Array<{ id: string }>).map(r => r.id)
    assert.deepEqual(a.changed.map(i => [i.columns, i.rows, i.row_ids]), [[['Email', 'Name'], 3, rowIds]])
    assert.ok(a.changed[0].data_version > before, 'data_version went up')
    const again = await call('append_rows', { sheet_id: sheet, rows, idempotency_key: 'k1' })
    assert.equal(again.replayed, true)
    assert.deepEqual(again.changed, a.changed)
  })

  await check('update_cells names the columns and rows it wrote, in both forms', async () => {
    const many = await call('update_cells', { sheet_id: sheet, updates: [
      { row_id: rowIds[0], data: { Name: 'Anna' } }, { row_id: rowIds[1], data: { Title: 'CEO' } }] })
    assert.deepEqual(many.changed.map(i => [i.sheet_id, i.columns, i.rows, i.row_ids]),
      [[sheet, ['Name', 'Title'], 2, rowIds.slice(0, 2)]])
    const one = await call('update_cells', { row_id: rowIds[1], data: { Name: 'Bo' } })
    assert.deepEqual(one.changed.map(i => [i.sheet_id, i.columns, i.rows, i.row_ids]),
      [[sheet, ['Name'], 1, [rowIds[1]]]])
  })

  await check('remove_duplicates: a dry run answers [], a removal the rows it removed', async () => {
    const dry = await call('remove_duplicates', { sheet_id: sheet, columns: ['Email'] })
    assert.equal(dry.rows_to_remove, 1)
    assert.deepEqual(dry.changed, [])
    const real = await call('remove_duplicates', { sheet_id: sheet, columns: ['Email'], dry_run: false })
    assert.deepEqual(real.changed.map(i => [i.columns, i.rows]), [[[], 1]])
  })

  await check('transform_column names its target and the rows it wrote', async () => {
    const a = await call('transform_column', { sheet_id: sheet, target_column: 'Upper', operation: 'upper',
      source_column: 'Email' })
    assert.deepEqual(a.changed.map(i => [i.columns, i.rows]), [[['Upper'], a.updated]])
    assert.equal(a.updated, 2)
  })

  await check('formula_column: a preview answers [], the column its name', async () => {
    const preview = await call('formula_column', { sheet_id: sheet, column: 'Domain',
      formula: "{{Email}}.split('@')[1]", preview: true })
    assert.deepEqual(preview.changed, [])
    const a = await call('formula_column', { sheet_id: sheet, column: 'Domain', formula: "{{Email}}.split('@')[1]" })
    assert.deepEqual(a.changed.map(i => i.columns), [['Domain']])
    assert.equal(a.changed[0].more_coming, a.status === 'filling' ? true : undefined)
  })

  await check('rename_column names the column by its new name; a sheet rename answers []', async () => {
    const a = await call('rename_column', { sheet_id: sheet, column: 'Title', new_name: 'Role' })
    assert.deepEqual(a.changed.map(i => i.columns), [['Role']])
    const r = await call('manage_sheet', { action: 'rename', table_id: made.id, sheet_id: sheet, name: 'Leads' })
    assert.deepEqual(r.changed, [])
  })

  const other = await call('manage_sheet', { action: 'create', table_id: made.id, name: 'Later' })
  const dest = (other.sheet as { id: string }).id
  await check('a new sheet answers itself, empty', () => {
    assert.deepEqual(other.changed.map(i => [i.sheet_id, i.columns, i.rows]), [[dest, [], 0]])
  })

  await check('a move answers both sheets: the destination\'s columns and rows, the rows the source lost', async () => {
    const a = await call('transfer_rows', { source_sheet_id: sheet, destination_sheet_id: dest, operation: 'move',
      selection: { row_ids: [rowIds[1]] }, columns: ['Email', 'Name'], idempotency_key: 't1' })
    assert.deepEqual(a.changed.map(i => [i.sheet_id, i.columns, i.rows]),
      [[dest, ['Email', 'Name'], 1], [sheet, [], 1]])
    const again = await call('transfer_rows', { source_sheet_id: sheet, destination_sheet_id: dest, operation: 'move',
      selection: { row_ids: [rowIds[1]] }, columns: ['Email', 'Name'], idempotency_key: 't1' })
    assert.deepEqual(again.changed, a.changed, 'a replay: the first call\'s')
  })

  await check('delete_rows names its rows; restore_from_trash brings them back with changed', async () => {
    const d = await call('delete_rows', { sheet_id: sheet, row_ids: [rowIds[0]] })
    assert.deepEqual(d.changed.map(i => [i.rows, i.row_ids]), [[1, [rowIds[0]]]])
    const back = await call('restore_from_trash', { trash_ids: [(d.trash as { trash_id: number }).trash_id] })
    assert.deepEqual(back.changed.map(i => [i.sheet_id, i.rows]), [[sheet, 1]])
  })

  await check('import_csv replace names the old and new columns, and the rows it took and brought', async () => {
    const rowsBefore = db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ?').pluck().get(dest) as number
    const a = await call('import_csv', { sheet_id: dest, csv: 'Company\nAcme\nGlobex\n', mode: 'replace' })
    assert.deepEqual(a.changed.map(i => [i.columns, i.rows]), [[['Email', 'Name', 'Company'], rowsBefore + 2]])
    assert.equal(a.changed[0].row_generation, versions(dest).row_generation)
  })

  await check('set_auto_dedupe names its key column', async () => {
    const a = await call('set_auto_dedupe', { sheet_id: dest, column: 'Company' })
    assert.deepEqual(a.changed.map(i => [i.sheet_id, i.columns, i.rows]), [[dest, ['Company'], 0]])
  })

  await check('the fields the schemas missed: each answer as its service builds it is strict-clean', async () => {
    type Parses = Record<string, { safeParse: (v: unknown) => { success: boolean; error?: unknown } }>
    const strict = (name: string, answer: object) => {
      const parsed = (TOOL_OUTPUTS as Parses)[name].safeParse({ ...answer, changed: [] })
      assert.ok(parsed.success, `${name}: ${JSON.stringify(parsed.error)}`)
    }
    const view = { column: 'D', formula: '{{A}}', inputs: ['A'], description: 'The domain', autoRun: true,
      autoRunNote: 'Paused: the column it reads is being filled', status: 'failed' as const, filledRows: 0,
      errorRows: 0, firstError: null, error: 'The formula stopped' }
    const json = formulaColumnJson(view)
    assert.deepEqual([json.description, json.auto_run_paused, json.error],
      ['The domain', 'Paused: the column it reads is being filled', 'The formula stopped'])
    strict('formula_column', { ...json, created: false })
    const sample = sampleAnswer({ tableId: 't', tableName: 'Sample leads', sheetId: 's', sheetName: 'Leads', rows: 3,
      filled: [], ai: { column: 'Good fit (Output)', name: 'Good fit', prompt: 'p', model: null, tryRowIds: [] },
      duplicates: null, problems: ['The clean column is still filling.'] }, 'mcp')
    assert.deepEqual(sample.problems, ['The clean column is still filling.'])
    strict('manage_table', sample)
    db.prepare(`INSERT INTO access_tokens (id,user_id,name,token_hash,token_prefix,scopes,spend_cap_micro)
      VALUES ('tok',?,'unit','hash','cbx_','["run"]',5000000)`).run(u)
    const spend = spendPart(u, 'tok')
    assert.ok(spend.token_spend, 'a capped token\'s start carries token_spend')
    strict('run_ai_column', { run_id: 'r', output_column: 'Hi (Output)', target_rows: 1, ...spend })
    // Through /mcp: a description kept with the column, and a preview whose formula runs out of time.
    const d = await call('formula_column', { sheet_id: sheet, column: 'Domain 2', formula: "{{Email}}.split('@')[1]",
      description: 'The domain of the email' })
    assert.equal(d.description, 'The domain of the email')
    // Three rows that each run out of time stop it.
    await call('append_rows', { sheet_id: dest, rows: [{ Company: 'Initech' }, { Company: 'Hooli' }] })
    const slow = await call('formula_column',
      { sheet_id: dest, column: 'Slow', formula: '(() => { while (true) {} })()', preview: true })
    assert.equal(typeof slow.stopped, 'string', JSON.stringify(slow))
    assert.deepEqual(slow.changed, [])
  })

  done()
}

main().catch(crash)
