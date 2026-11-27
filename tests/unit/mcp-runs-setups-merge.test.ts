// Over 200 lines: one account's sheets, runs and setups, each part building on the last.
// Fewer MCP tools, runs, setups, stored answers and file links: undo_run and control_setup_run are control_run's
// undo and setup_run_id; save_setup and delete_setup are manage_setup; restore_setup_version is
// manage_setup_version's restore; write_formula is formula_column's from_words; set_auto_dedupe is remove_duplicates'
// keep_doing; add_enrichment_field and add_list_rows are stored_answers; create_upload_link and create_download_link
// are file_link. Each old name tells its caller what to call instead; each action takes its old tool's fields and
// refuses another action's, under its old tool's scope; and every REST body those tools gave stays as it was.
import assert from 'node:assert/strict'
import { toolHintsKit } from './mcp-tool-hints-kit'
import changesMod from '../../server/src/services/version-changes'
import documentMod from '../../server/src/openapi/document'
const { replacedTools } = changesMod as typeof import('../../server/src/services/version-changes')
const { openApiDocument } = documentMod as typeof import('../../server/src/openapi/document')

const { db, uid, sheet, call, check, done, crash } = toolHintsKit('mcp-runs-setups-merge')
globalThis.fetch = async () => { throw new Error('no network in this test') }
const READ = ['read'] as const
const WRITE = ['read', 'write'] as const
const ALL = ['read', 'write', 'run', 'secrets'] as const
const parsed = async (tool: string, args: Record<string, unknown>, scopes: readonly string[] = ALL) => {
  const text = await call(tool, args, scopes)
  assert.doesNotMatch(text, /^ERROR/, `${tool} ${JSON.stringify(args)}`)
  return JSON.parse(text)
}
const refusal = async (tool: string, args: Record<string, unknown>, scopes: readonly string[] = ALL) => {
  const text = await call(tool, args, scopes)
  assert.match(text, /^ERROR \{/, `${tool} ${JSON.stringify(args)}: ${text.slice(0, 200)}`)
  return JSON.parse(text.slice('ERROR '.length)).error as string
}
const needs = (scope: string) => `This action requires the '${scope}' scope on your Cubex access token.`

async function main() {
  await check('each old name says which tool, and which action or field, to call instead', () => {
    const replaced = replacedTools()
    const to: Record<string, [string, string]> = {
      undo_run: ['control_run', 'action "undo"'], control_setup_run: ['control_run', 'setup_run_id'],
      save_setup: ['manage_setup', 'action "save"'], delete_setup: ['manage_setup', 'action "delete"'],
      restore_setup_version: ['manage_setup_version', 'action "restore"'],
      write_formula: ['formula_column', 'from_words'], set_auto_dedupe: ['remove_duplicates', 'keep_doing'],
      add_enrichment_field: ['stored_answers', 'action "add_column"'],
      add_list_rows: ['stored_answers', 'action "add_rows"'],
      create_upload_link: ['file_link', 'action "upload"'], create_download_link: ['file_link', 'action "download"'],
    }
    for (const [old, [tool, how]] of Object.entries(to)) {
      const said = replaced.get(old) ?? ''
      assert.ok(said.startsWith(`${old} was renamed to ${tool} in Cubex v0.8.47: call ${tool} instead. `), said)
      assert.ok(said.includes(how), said)
    }
  })

  const s = sheet('People', ['Name', 'Email', 'Fit', 'Fit score'], [
    { Name: 'Ann', Email: 'ann@x.com', Fit: '✅ Done', 'Fit score': '9' },
    { Name: 'Bob', Email: 'ann@x.com', Fit: '', 'Fit score': '' }])
  const runId = 'b6f1c5a2-0000-4000-8000-0000000000c1'
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name)
    VALUES (?, ?, ?, ?, 'completed', 2, 'Fit')`).run(runId, s, uid,
    JSON.stringify({ requestConfig: { url: 'https://api.example.com/x', method: 'GET' },
      responseMapping: [{ jsonPath: '$.fit', columnName: 'Fit score' }] }))

  await check('control_run: undo under write (a dry run under read), setup runs by setup_run_id', async () => {
    const view = await parsed('control_run', { action: 'undo', run_type: 'http', run_id: runId, dry_run: true }, READ)
    assert.deepEqual([view.run_id, view.sheet_id, typeof view.can_undo, view.changed], [runId, s, 'boolean', []])
    assert.equal(await refusal('control_run', { action: 'undo', run_type: 'http', run_id: runId }, READ),
      needs('write'))
    assert.match(await refusal('control_run', { action: 'undo', sheet_id: s, column: 'Name', dry_run: true }, READ),
      /^"Name" has no run that can still be undone/)
    assert.equal(await refusal('control_run', { action: 'undo', run_type: 'http', run_id: runId, mode: 'all' }),
      'mode is not for undo: it takes run_type and run_id, or sheet_id and column, and dry_run.')
    assert.equal(await refusal('control_run', { action: 'pause', run_type: 'http', run_id: runId, dry_run: true }),
      'dry_run is for action undo only.')
    assert.equal(await refusal('control_run', { action: 'pause', setup_run_id: 'nope' }), 'Setup run not found')
    assert.equal(await refusal('control_run', { action: 'pause', setup_run_id: 'nope' }, WRITE), needs('run'))
    assert.match(await refusal('control_run', { action: 'rerun', setup_run_id: 'nope' }),
      /^setup_run_id goes with pause, resume or cancel\. To run a setup again/)
    assert.equal(await refusal('control_run', { action: 'cancel', setup_run_id: 'nope', run_id: runId }),
      'run_id is not for a setup run: send setup_run_id and action alone.')
    assert.equal(await refusal('control_run', { action: 'pause', sheet_id: s }),
      'sheet_id goes with action cancel_all, or undo with column.')
  })

  await check('manage_setup: save (a preview under read) and delete, each with its own fields', async () => {
    const preview = await parsed('manage_setup', { action: 'save', sheet_id: s, columns: ['Fit'], preview: true },
      READ)
    assert.ok(Array.isArray(preview.steps), JSON.stringify(preview))
    assert.equal(await refusal('manage_setup', { action: 'save', sheet_id: s, name: 'Fit', columns: ['Fit'] }, READ),
      needs('write'))
    const saved = await parsed('manage_setup', { action: 'save', sheet_id: s, name: 'Fit', columns: ['Fit'] }, WRITE)
    assert.equal(await refusal('manage_setup', { action: 'save', sheet_id: s, columns: ['Fit'], setup_id: saved.id },
      WRITE), 'setup_id is not for save: it takes sheet_id, columns, name, description, include_upstream, preview.')
    assert.equal(await refusal('manage_setup', { action: 'delete' }, WRITE), 'delete needs setup_id.')
    assert.deepEqual(await parsed('manage_setup', { action: 'delete', setup_id: saved.id }, WRITE),
      { deleted: saved.id })
  })

  await check('manage_setup_version: save, rename and delete answer changed [], restore\'s dry run reads', async () => {
    const saved = await parsed('manage_setup_version', { sheet_id: s, action: 'save', name: 'Before' }, WRITE)
    assert.deepEqual([saved.version.name, saved.changed], ['Before', []])
    const id = saved.version.id
    const dry = await parsed('manage_setup_version', { sheet_id: s, action: 'restore', version_id: id }, READ)
    assert.deepEqual([dry.dry_run, dry.changed], [true, []])
    assert.equal(await refusal('manage_setup_version',
      { sheet_id: s, action: 'restore', version_id: id, dry_run: false }, WRITE), needs('run'))
    assert.equal(await refusal('manage_setup_version', { sheet_id: s, action: 'restore' }, READ),
      'restore needs version_id (list_setup_versions lists them).')
    assert.equal(await refusal('manage_setup_version', { sheet_id: s, action: 'save', name: 'X', dry_run: true },
      WRITE), 'dry_run is not for save: it takes name, description.')
    const renamed = await parsed('manage_setup_version',
      { sheet_id: s, action: 'rename', version_id: id, name: 'After' }, WRITE)
    assert.deepEqual([renamed.version.name, renamed.changed], ['After', []])
    assert.deepEqual(await parsed('manage_setup_version', { sheet_id: s, action: 'delete', version_id: id }, WRITE),
      { ok: true, changed: [] })
  })

  await check('formula_column\'s from_words takes only from_words and model, under the run scope', async () => {
    assert.equal(await refusal('formula_column', { sheet_id: s, from_words: 'the email' }, WRITE), needs('run'))
    assert.equal(await refusal('formula_column', { sheet_id: s, from_words: 'the email', formula: '{{Email}}' }),
      'formula is not for from_words: it takes sheet_id, from_words and model, and saves nothing. Pass the formula '
      + 'it answers as formula.')
    assert.equal(await refusal('formula_column', { sheet_id: s, formula: '{{Email}}', model: 'x/y' }),
      'model goes with from_words only: a formula column makes no AI calls.')
    assert.equal(await refusal('formula_column', { sheet_id: s, column: 'Mail' }),
      'Pass formula, or from_words to have one written from plain words.')
    const preview = await parsed('formula_column', { sheet_id: s, formula: '{{Email}}', preview: true }, WRITE)
    assert.equal(preview.formula, '{{Email}}')
  })

  await check('remove_duplicates\' keep_doing sets auto-dedupe under write, and takes none of the rest', async () => {
    const found = await parsed('remove_duplicates', { sheet_id: s, columns: ['Email'] }, READ)
    assert.equal(found.dry_run, true)
    assert.equal(await refusal('remove_duplicates', { sheet_id: s, keep_doing: { column: 'Email' } }, READ),
      needs('write'))
    assert.match(await refusal('remove_duplicates', { sheet_id: s, columns: ['Email'], keep_doing: false }, WRITE),
      /^columns is not for keep_doing: it sets auto-dedupe from now on/)
    assert.match(await refusal('remove_duplicates', { sheet_id: s, keep_doing: true }, WRITE),
      /^keep_doing takes the key: \{ column, match, keep \}/)
    assert.match(await refusal('remove_duplicates', { sheet_id: s }, WRITE), /^Pass columns to find duplicates now/)
    const on = await parsed('remove_duplicates', { sheet_id: s, keep_doing: { column: 'Email', match: 'email' } },
      WRITE)
    assert.deepEqual([on.auto_dedupe.column, on.auto_dedupe.match, on.auto_dedupe.keep], ['Email', 'email', 'oldest'])
    const newest = await parsed('remove_duplicates', { sheet_id: s, keep_doing: { keep: 'newest' } }, WRITE)
    assert.deepEqual([newest.auto_dedupe.column, newest.auto_dedupe.keep], ['Email', 'newest'], 'fields left out stay')
    const off = await parsed('remove_duplicates', { sheet_id: s, keep_doing: false }, WRITE)
    assert.equal(off.auto_dedupe, null)
  })

  await check('stored_answers: each action\'s fields, under write', async () => {
    assert.equal(await refusal('stored_answers', { action: 'add_rows', sheet_id: s, column: 'Fit', fields: [] }, READ),
      needs('write'))
    assert.equal(await refusal('stored_answers', { action: 'add_column', sheet_id: s, column: 'Fit',
      json_path: '$.x', column_name: 'X', fields: [{ path: '$.a', column_name: 'A' }] }, WRITE),
    'fields is not for add_column: it takes json_path, column_name, row_id.')
    assert.equal(await refusal('stored_answers', { action: 'add_rows', sheet_id: s, column: 'Fit' }, WRITE),
      'add_rows needs fields.')
    assert.equal(await refusal('stored_answers', { action: 'add_column', sheet_id: s, column: 'Fit',
      json_path: '$.x' }, WRITE), 'add_column needs column_name.')
  })

  await check('file_link: a download under read (by sheet_id or setup_run_id), an upload under write', async () => {
    const down = await parsed('file_link', { action: 'download', sheet_id: s, columns: ['Name'] }, READ)
    assert.deepEqual(down.columns, ['Name'])
    assert.match(down.curl, /^curl -sS -f -o <file\.csv> 'http:\/\/127\.0\.0\.1:1\//)
    assert.equal(await refusal('file_link', { action: 'download', setup_run_id: 'nope' }, READ), 'Setup call not found')
    assert.match(await refusal('file_link', { action: 'upload', sheet_id: s }, READ),
      /^This action requires the 'write' scope/)
    const up = await parsed('file_link', { action: 'upload', sheet_id: s }, WRITE)
    assert.equal(up.mode, 'append')
    assert.equal(await refusal('file_link', { action: 'download', sheet_id: s, mode: 'append' }, READ),
      'mode is not for download: it takes sheet_id, setup_run_id, columns, where, view, format, raw.')
    assert.equal(await refusal('file_link', { action: 'upload', sheet_id: s, setup_run_id: 'x' }, WRITE),
      'setup_run_id is not for upload: it takes sheet_id, mode, setup_id, max_cost_usd, allow_unpriced, models, '
      + 'webhook_id.')
  })

  await check('REST bodies stay what the old tools took', () => {
    type Body = { properties?: Record<string, { enum?: string[] }>; required?: string[] }
    const paths = (openApiDocument() as { paths: Record<string, Record<string, { requestBody?: {
      content: Record<string, { schema: Body }> } }>> }).paths
    const body = (path: string, method: string) => paths[path][method].requestBody!.content['application/json'].schema
    const fields = (path: string, method = 'post') => Object.keys(body(path, method).properties ?? {}).sort()
    assert.deepEqual(fields('/sheets/{id}/formula-columns'),
      ['auto_run', 'column', 'description', 'formula', 'preview'])
    assert.deepEqual(body('/sheets/{id}/formula-columns', 'post').required, ['formula'])
    assert.deepEqual(fields('/sheets/{id}/formula-columns/write'), ['model', 'words'])
    assert.deepEqual(fields('/sheets/{id}/remove-duplicates'), ['columns', 'dry_run', 'keep'])
    assert.deepEqual(fields('/sheets/{id}/auto-dedupe', 'put'), ['column', 'keep', 'match', 'phone_country'])
    assert.deepEqual(fields('/sheets/{id}/enrichment-fields'), ['column', 'column_name', 'json_path', 'row_id'])
    assert.deepEqual(fields('/sheets/{id}/enrichment-list-fields'), ['column', 'dedupe_path', 'fields'])
    assert.deepEqual(fields('/sheets/{id}/setup-versions/{versionId}/restore'), ['dry_run'])
    assert.deepEqual(body('/setup-runs/{runId}/control', 'post').properties?.action.enum, ['pause', 'resume', 'cancel'])
  })

  done()
}
main().catch(crash)
