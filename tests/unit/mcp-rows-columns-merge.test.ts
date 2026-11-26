// Fewer MCP tools, rows and columns: update_cells and delete_rows are change_rows, add_column, rename_column,
// set_description, set_column_order and delete_column are manage_column, sort_sheet and a sheet's description are
// manage_sheet's sort and describe, and export_csv is read_rows' format csv. Each old name tells its caller what
// to call instead; each action takes its old tool's fields and refuses another action's, and nothing changes then;
// sort and describe need no table_id; format csv answers what export_csv did and refuses what it can't do; and
// REST's sort body is the one sort_sheet gave it.
import assert from 'node:assert/strict'
import { toolHintsKit } from './mcp-tool-hints-kit'
import changesMod from '../../server/src/services/version-changes'
import documentMod from '../../server/src/openapi/document'
const { replacedTools } = changesMod as typeof import('../../server/src/services/version-changes')
const { openApiDocument } = documentMod as typeof import('../../server/src/openapi/document')

const { db, tid, sheet, call, check, done, crash } = toolHintsKit('mcp-rows-columns-merge')
const ALL = ['read', 'write', 'run', 'secrets'] as const
const READ = ['read'] as const
const parsed = async (tool: string, args: Record<string, unknown>, scopes: readonly string[] = ALL) => {
  const text = await call(tool, args, scopes)
  assert.doesNotMatch(text, /^ERROR/)
  return JSON.parse(text)
}
// A refusal's message (the tool answers {"error": "..."}).
const refusal = async (tool: string, args: Record<string, unknown>, scopes: readonly string[] = ALL) => {
  const text = await call(tool, args, scopes)
  assert.match(text, /^ERROR \{/)
  return JSON.parse(text.slice('ERROR '.length)).error as string
}
const order = (id: string) => JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck()
  .get(id) as string) as string[]
const names = (id: string) => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
  .all(id) as string[]).map(d => JSON.parse(d).Name)

async function main() {
  await check('each old name says which tool and action to call instead', () => {
    const replaced = replacedTools()
    const to: Record<string, [string, string]> = {
      update_cells: ['change_rows', 'action "update"'], delete_rows: ['change_rows', 'action "delete"'],
      add_column: ['manage_column', 'action "add"'], rename_column: ['manage_column', 'action "rename"'],
      delete_column: ['manage_column', 'action "delete"'], set_column_order: ['manage_column', 'action "reorder"'],
      set_description: ['manage_column', 'action "describe"'], sort_sheet: ['manage_sheet', 'action "sort"'],
      export_csv: ['read_rows', 'format "csv"'],
    }
    for (const [old, [tool, how]] of Object.entries(to)) {
      const said = replaced.get(old) ?? ''
      assert.ok(said.startsWith(`${old} was renamed to ${tool} in Cubex v0.8.46: call ${tool} instead. `), said)
      assert.ok(said.includes(`${tool} with ${how}`), said)
    }
    assert.match(replaced.get('set_description')!, /manage_sheet with action "describe", sheet_id and description/)
  })

  const s = sheet('Merge', ['Name', 'Note'], [{ Name: 'Ann', Note: 'a' }, { Name: 'Bob', Note: 'b' },
    { Name: 'Cy', Note: 'c' }])
  const ids = db.prepare('SELECT id FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(s) as string[]

  await check('change_rows updates in both forms and deletes to the trash', async () => {
    assert.equal((await parsed('change_rows', { action: 'update', row_id: ids[0], data: { Note: 'A' } })).data.Note,
      'A')
    const many = await parsed('change_rows', { action: 'update', sheet_id: s,
      updates: [{ row_id: ids[1], data: { Note: 'B' } }] })
    assert.equal(many.updated, 1)
    const gone = await parsed('change_rows', { action: 'delete', sheet_id: s, row_ids: [ids[2]] })
    assert.equal(gone.deleted, 1)
    assert.ok(gone.trash, JSON.stringify(gone))
    assert.deepEqual(names(s), ['Ann', 'Bob'])
  })

  await check('change_rows refuses another action\'s fields, and writes nothing', async () => {
    const before = db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(s)
    assert.equal(await refusal('change_rows', { action: 'update', sheet_id: s, row_ids: [ids[0]] }),
      'row_ids is for delete; update takes row_id and data, or updates.')
    assert.equal(await refusal('change_rows', { action: 'delete', sheet_id: s, row_ids: [ids[0]],
      data: { Note: 'x' } }),
      'row_id, data, updates and idempotency_key are for update; delete takes sheet_id and row_ids.')
    assert.equal(await refusal('change_rows', { action: 'delete', row_ids: [ids[0]] }),
      'delete needs sheet_id and row_ids.')
    assert.match(await refusal('change_rows', { action: 'update', sheet_id: s }), /^Use one form/)
    assert.deepEqual(db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(s), before)
  })

  await check('manage_column adds, describes, renames, reorders and deletes, each with its old tool\'s fields',
    async () => {
      assert.equal((await parsed('manage_column', { action: 'add', sheet_id: s, name: 'Fit', description: 'How' }))
        .name, 'Fit')
      const described = await parsed('manage_column', { action: 'describe', sheet_id: s, column: 'Fit',
        description: 'How well' })
      assert.deepEqual([described.column, described.description], ['Fit', 'How well'])
      assert.equal((await parsed('manage_column', { action: 'rename', sheet_id: s, column: 'Fit', new_name: 'Score' }))
        .name, 'Score')
      assert.deepEqual((await parsed('manage_column', { action: 'reorder', sheet_id: s,
        order: ['Score', 'Name', 'Note'] })).order, ['Score', 'Name', 'Note'])
      assert.deepEqual(order(s), ['Score', 'Name', 'Note'])
      assert.equal((await parsed('manage_column', { action: 'delete', sheet_id: s, column: 'Score' })).deleted, true)
      assert.deepEqual(order(s), ['Name', 'Note'])
    })

  await check('manage_column refuses a field another action takes and says what is missing; nothing changes',
    async () => {
      const refused = (args: Record<string, unknown>) => refusal('manage_column', { sheet_id: s, ...args })
      assert.equal(await refused({ action: 'add', name: 'X', new_name: 'Y' }),
        'new_name is not for add: it takes name, description.')
      assert.equal(await refused({ action: 'reorder', order: ['Note', 'Name'], column: 'Name' }),
        'column is not for reorder: it takes order.')
      assert.equal(await refused({ action: 'rename', column: 'Name' }), 'rename needs new_name.')
      assert.equal(await refused({ action: 'describe', column: 'Name' }), 'describe needs description.')
      assert.equal(await refused({ action: 'delete', sheet_id: 'nope', column: 'Name' }), 'Sheet not found')
      assert.deepEqual(order(s), ['Name', 'Note'])
    })

  await check('manage_sheet sorts and describes by sheet_id alone; its other actions still need table_id',
    async () => {
      assert.equal(typeof (await parsed('manage_sheet', { action: 'sort', sheet_id: s, column: 'Name',
        direction: 'desc' })).rows_reordered, 'number')
      assert.deepEqual(names(s), ['Bob', 'Ann'])
      assert.equal((await parsed('manage_sheet', { action: 'describe', sheet_id: s, description: 'People' }))
        .description, 'People')
      assert.equal((await parsed('manage_sheet', { action: 'describe', table_id: tid, sheet_id: s,
        description: '' })).description, null)
      const refused = (args: Record<string, unknown>) => refusal('manage_sheet', args)
      assert.equal(await refused({ action: 'sort', table_id: 'other', sheet_id: s, column: 'Name',
        direction: 'asc' }), 'Sheet not found')
      assert.equal(await refused({ action: 'sort', sheet_id: s, column: 'Name' }), 'sort needs column and direction.')
      assert.equal(await refused({ action: 'describe', sheet_id: s, description: 'x', column: 'Name' }),
        'column and direction are for sort.')
      assert.equal(await refused({ action: 'sort', sheet_id: s, column: 'Name', direction: 'asc', description: 'x' }),
        'description is for describe.')
      assert.equal(await refused({ action: 'rename', sheet_id: s, name: 'X' }), 'table_id is required for rename')
      assert.equal(await refused({ action: 'rename', table_id: tid, sheet_id: s, name: 'X', direction: 'asc' }),
        'column and direction are for sort.')
      assert.deepEqual(names(s), ['Bob', 'Ann'])
    })

  await check('read_rows format csv answers what export_csv did; other read fields and JSON picks are refused',
    async () => {
      const csv = await parsed('read_rows', { sheet_id: s, format: 'csv', columns: ['Name'],
        where: [{ column: 'Name', operator: 'eq', value: 'Ann' }] }, READ)
      assert.deepEqual([csv.csv, csv.row_count, csv.sheet_name, csv.columns], ['"Name"\r\n"Ann"', 1, 'Merge', ['Name']])
      const versions = db.prepare('SELECT data_version, row_generation FROM sheets WHERE id = ?').get(s)
      assert.deepEqual({ data_version: csv.data_version, row_generation: csv.row_generation }, versions)
      assert.equal((await parsed('read_rows', { sheet_id: s, format: 'csv' }, READ)).csv,
        '"Name","Note"\r\n"Bob","B"\r\n"Ann","A"')
      assert.equal(await refusal('read_rows', { sheet_id: s, format: 'csv', limit: 5, return_mode: 'count' }, READ),
        'format csv takes only columns, where and view, not limit, return_mode.')
      assert.match(await refusal('read_rows', { sheet_id: s, format: 'csv',
        columns: [{ column: 'Name', path: ['a'] }] }, READ), /^format csv takes column names only/)
      assert.equal((await parsed('read_rows', { sheet_id: s, format: 'json' }, READ)).rows.length, 2)
    })

  await check('REST\'s sort body is the one sort_sheet gave it: column and direction, both required', () => {
    const doc = openApiDocument() as { paths: Record<string, Record<string, { requestBody?: {
      content: Record<string, { schema: { required?: string[]; properties: Record<string, Record<string, unknown>> } }>
    } }>> }
    const body = doc.paths['/sheets/{id}/sort'].post.requestBody!.content['application/json'].schema
    assert.deepEqual(body.required, ['column', 'direction'])
    assert.deepEqual(body.properties.column, { type: 'string', description: 'The column to sort by' })
    assert.deepEqual(body.properties.direction,
      { type: 'string', enum: ['asc', 'desc'], description: 'asc: A to Z, smallest first; desc: the other way' })
  })

  done()
}
main().catch(crash)
