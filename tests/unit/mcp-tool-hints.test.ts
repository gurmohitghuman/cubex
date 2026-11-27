// Every MCP tool's readOnlyHint and destructiveHint (server/src/mcp/tool-annotations.ts)
// against what the tool does, with the tools called as an agent calls them:
//   - read-only exactly when the read scope is enough: every other tool refuses
//     a read-only token first (file_link with its upload: its download only
//     reads the sheet, but the link it makes is a credential, so it says it
//     changes something too, mcp-annotations.test.ts);
//   - a read-only tool writes nothing to the database, called on real data;
//   - a tool that says it only adds (destructiveHint false) leaves every row,
//     cell and column already there as it was; a name already taken is refused
//     or the restored item gets a new one; and the actions that only add or only
//     read in tools that also change (manage_setup's save, stored_answers'
//     add_column, file_link's download) do the same.
// mcp-tool-hints-writes.test.ts: append_rows and stored_answers' add_rows can replace a row, and
// the two AI writers change nothing in the sheet.
import assert from 'node:assert/strict'
import { toolHintsKit } from './mcp-tool-hints-kit'

const { db, uid, tid, sheet, tools, call, hints, snapshot, check, done, crash } = toolHintsKit('mcp-tool-hints')
// No call reaches the network: a tool that would (models, balances, the
// enrichment catalog) fails instead, and must still write nothing.
globalThis.fetch = async () => { throw new Error('no network in this test') }

const ALL = ['read', 'write', 'run', 'secrets'] as const
const READ_ONLY_TOKEN = ['read'] as const
// Both preview by default (dry_run true), which reads only; dry_run false is the write.
// file_link's download needs only read; its upload needs write.
const WRITE_ARGS: Record<string, Record<string, unknown>> = {
  remove_duplicates: { dry_run: false }, manage_setup_version: { action: 'restore', dry_run: false },
  file_link: { action: 'upload' },
}
const SCOPE_EXCEPTIONS: string[] = []

async function main() {
  const people = sheet('People', ['Name', 'Email', 'Fit', 'Fit score'], [
    { Name: 'Ann', Email: 'ann@x.com', Fit: '✅ Done', 'Fit score': '9' },
    { Name: 'Bob', Email: '', Fit: '', 'Fit score': '' }])
  const runId = 'b6f1c5a2-0000-4000-8000-000000000001'
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name)
    VALUES (?, ?, ?, ?, 'completed', 2, 'Fit')`).run(runId, people, uid,
    JSON.stringify({ requestConfig: { url: 'https://api.example.com/x', method: 'GET' },
      responseMapping: [{ jsonPath: '$.fit', columnName: 'Fit score' }] }))

  await check('every tool has hints, and the table names no tool that does not exist', () => {
    assert.deepEqual(Object.keys(hints).sort(), [...tools.keys()].sort())
  })

  await check('read-only exactly when a read-only token may call it', async () => {
    const refused: string[] = []
    for (const name of tools.keys()) {
      const text = await call(name, WRITE_ARGS[name] ?? {}, READ_ONLY_TOKEN)
      if (/requires the '\w+' scope/.test(text)) refused.push(name)
    }
    const notReadOnly = [...tools.keys()].filter(name => !hints[name].readOnlyHint)
    assert.deepEqual(refused.sort(), notReadOnly.filter(n => !SCOPE_EXCEPTIONS.includes(n)).sort())
    for (const name of SCOPE_EXCEPTIONS) assert.equal(hints[name].readOnlyHint, false, name)
  })

  await check('a read-only tool writes nothing, called on real data', async () => {
    // Each read-only tool's calls: every action of the merged reads; [args, true] must succeed as well.
    const args: Record<string, Array<[Record<string, unknown>, boolean?]>> = {
      get_workspace: [[{}, true], [{ all_tables: true }, true]],
      get_sheet: [[{ sheet_id: people, include_counts: true }, true], [{ sheet_id: people, history: true }, true]],
      read_rows: [[{ sheet_id: people }, true], [{ sheet_id: people, format: 'csv' }, true]],
      get_run: [[{ action: 'list', sheet_id: people }, true],
        [{ action: 'status', run_type: 'http', run_id: runId }, true],
        [{ action: 'results', run_type: 'http', run_id: runId }, true], [{ action: 'setup', sheet_id: people }, true]],
      // Balances asks treg and OpenRouter, which this test can't reach: it fails, writing nothing.
      get_account: [[{ action: 'usage', sheet_id: people }, true], [{ action: 'saved_keys' }, true],
        [{ action: 'version' }, true], [{ action: 'balances' }]],
      check_run_condition: [[{ sheet_id: people, rule: '{{Email}} is not empty' }, true]],
      find_enrichments: [[{ action: 'search', query: 'email' }], [{ action: 'get', tool_id: 'x' }]],
      get_list_fields: [[{ sheet_id: people, column: 'Fit' }]], list_setup_versions: [[{ sheet_id: people }, true]],
      list_trash: [[{}, true]], list_setups: [[{}, true]], list_run_webhooks: [[{}, true]],
      get_tool_guide: [[{}, true]],
    }
    const readOnly = [...tools.keys()].filter(name => hints[name].readOnlyHint)
    assert.ok(readOnly.length >= 15, `${readOnly.length} read-only tools`)
    for (const name of readOnly) {
      for (const [a, mustAnswer] of args[name] ?? [[{}]]) {
        const before = snapshot()
        const changes = db.prepare('SELECT total_changes()').pluck().get() as number
        const text = await call(name, a, ALL)
        const what = `${name} ${JSON.stringify(a)}`
        assert.equal(db.prepare('SELECT total_changes()').pluck().get(), changes,
          `${what} wrote: ${text.slice(0, 200)}`)
        assert.deepEqual(snapshot(), before, what)
        if (mustAnswer) assert.ok(!text.startsWith('ERROR'), `${what}: ${text.slice(0, 300)}`)
      }
    }
  })

  // manage_column also deletes, so its hint says destructive; its add still only adds.
  await check('manage_column add only adds: a taken name is refused, a new one leaves every cell alone', async () => {
    assert.equal(hints.manage_column.destructiveHint, true)
    const before = snapshot()
    assert.match(await call('manage_column', { action: 'add', sheet_id: people, name: 'email' }, ALL), /^ERROR/)
    assert.deepEqual(snapshot(), before)
    assert.doesNotMatch(await call('manage_column', { action: 'add', sheet_id: people, name: 'Phone' }, ALL), /^ERROR/)
    assert.deepEqual(snapshot().rows, before.rows)
  })

  await check('restore_from_trash only adds: a restored column whose name is taken comes back renamed', async () => {
    assert.equal(hints.restore_from_trash.destructiveHint, false)
    const s = sheet('Restore', ['Name', 'Note'], [{ Name: 'Ann', Note: 'old' }])
    assert.doesNotMatch(await call('manage_column', { action: 'delete', sheet_id: s, column: 'Note' }, ALL), /^ERROR/)
    const trashId = db.prepare('SELECT id FROM trash_items WHERE user_id = ? ORDER BY id DESC').pluck().get(uid)
    assert.doesNotMatch(await call('manage_column', { action: 'add', sheet_id: s, name: 'Note' }, ALL), /^ERROR/)
    const rowId = db.prepare('SELECT id FROM rows WHERE sheet_id = ?').pluck().get(s)
    assert.doesNotMatch(await call('change_rows', {
      action: 'update', sheet_id: s, updates: [{ row_id: rowId, data: { Note: 'new' } }] },
      ALL), /^ERROR/)
    const before = snapshot()
    assert.doesNotMatch(await call('restore_from_trash', { trash_ids: [trashId] }, ALL), /^ERROR/)
    const after = snapshot()
    const data = JSON.parse(after.rows.find(r => r.sheet_id === s)!.data)
    assert.equal(data.Note, 'new', 'the column already there keeps its cells')
    assert.ok(Object.entries(data).some(([k, v]) => k !== 'Note' && v === 'old'), JSON.stringify(data))
    assert.deepEqual(after.rows.filter(r => r.sheet_id !== s), before.rows.filter(r => r.sheet_id !== s))
  })

  // The tools these actions are part of take the stricter hint (an upload in replace mode, a setup's delete, rows
  // that replace a row): each of these actions still only reads or only adds.
  await check('file_link\'s download changes no row, cell, column or setup', async () => {
    assert.equal(hints.file_link.destructiveHint, true)
    const before = snapshot()
    assert.doesNotMatch(await call('file_link', { action: 'download', sheet_id: people }, ALL), /^ERROR/)
    assert.deepEqual(snapshot(), before)
  })

  await check('manage_setup\'s save and stored_answers\' add_column only add: a taken name is refused', async () => {
    const save = { action: 'save', sheet_id: people, name: 'Fit check', columns: ['Fit'] }
    const first = await call('manage_setup', save, ALL)
    assert.doesNotMatch(first, /^ERROR/)
    const setups = () => db.prepare('SELECT id, name, updated_at FROM setups WHERE user_id = ?').all(uid)
    const kept = setups()
    assert.match(await call('manage_setup', save, ALL), /^ERROR/)
    assert.deepEqual(setups(), kept)
    const before = snapshot()
    const clash = await call('stored_answers',
      { action: 'add_column', sheet_id: people, column: 'Fit', json_path: '$.score', column_name: 'Name' }, ALL)
    assert.match(clash, /^ERROR.*A column named \\"Name\\" already exists/)
    assert.deepEqual(snapshot(), before)
    for (const name of ['manage_setup', 'stored_answers']) assert.equal(hints[name].destructiveHint, true, name)
  })

  void tid
  done()
}

main().catch(crash)
