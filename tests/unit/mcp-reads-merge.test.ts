// Fewer MCP tools, the reads: get_run_status, get_run_results, list_runs and get_setup_run are get_run; get_balances,
// get_usage, list_saved_keys and get_version are get_account; search_enrichments and get_enrichment are
// find_enrichments; list_tables is get_workspace's all_tables and get_sheet_history get_sheet's history. Each old name
// tells its caller what to call instead; each action takes its old tool's fields and refuses another action's; the
// modes answer what the old tools did; each action's limit keeps its old range.
import assert from 'node:assert/strict'
import { toolHintsKit } from './mcp-tool-hints-kit'
import changesMod from '../../server/src/services/version-changes'
import readMod from '../../server/src/services/workspace-read'
import historyMod from '../../server/src/services/sheet-history'
import versionMod from '../../server/src/services/version-info'
const { replacedTools } = changesMod as typeof import('../../server/src/services/version-changes')
const { listTablesWithSheets } = readMod as typeof import('../../server/src/services/workspace-read')
const { readSheetHistory } = historyMod as typeof import('../../server/src/services/sheet-history')
const { versionInfo } = versionMod as typeof import('../../server/src/services/version-info')

const { db, uid, sheet, call, check, done, crash } = toolHintsKit('mcp-reads-merge')
globalThis.fetch = async () => { throw new Error('no network in this test') }
const READ = ['read'] as const
const parsed = async (tool: string, args: Record<string, unknown>) => {
  const text = await call(tool, args, READ)
  assert.doesNotMatch(text, /^ERROR/)
  return JSON.parse(text)
}
const refusal = async (tool: string, args: Record<string, unknown>) => {
  const text = await call(tool, args, READ)
  assert.match(text, /^ERROR \{/)
  return JSON.parse(text.slice('ERROR '.length)).error as string
}

async function main() {
  await check('each old name says which tool, and which action or mode, to call instead', () => {
    const replaced = replacedTools()
    const to: Record<string, [string, string]> = {
      get_run_status: ['get_run', 'action "status"'], get_run_results: ['get_run', 'action "results"'],
      list_runs: ['get_run', 'action "list"'], get_setup_run: ['get_run', 'action "setup"'],
      get_setup_call: ['get_run', 'action "setup"'],
      get_balances: ['get_account', 'action "balances"'], get_usage: ['get_account', 'action "usage"'],
      list_saved_keys: ['get_account', 'action "saved_keys"'], get_version: ['get_account', 'action "version"'],
      list_tables: ['get_workspace', 'all_tables: true'], get_sheet_history: ['get_sheet', 'history: true'],
      search_enrichments: ['find_enrichments', 'action "search"'], get_enrichment: ['find_enrichments', 'action "get"'],
    }
    for (const [old, [tool, how]] of Object.entries(to)) {
      const said = replaced.get(old) ?? ''
      assert.ok(said.startsWith(`${old} was renamed to ${tool} in Cubex v0.8.47: call ${tool} instead. `), said)
      assert.ok(said.includes(how), said)
    }
  })

  const s = sheet('Reads', ['Name'], [{ Name: 'Ann' }, { Name: 'Bob' }])
  const runId = 'b6f1c5a2-0000-4000-8000-0000000000aa'
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name)
    VALUES (?, ?, ?, ?, 'completed', 2, 'Fit')`).run(runId, s, uid,
    JSON.stringify({ requestConfig: { url: 'https://api.example.com/x', method: 'GET' }, responseMapping: [] }))

  await check('get_run: status, results, list and setup answer as their tools did', async () => {
    const status = await parsed('get_run', { action: 'status', run_type: 'http', run_id: runId })
    assert.deepEqual([status.id, status.status, status.total_rows], [runId, 'completed', 2])
    const results = await parsed('get_run', { action: 'results', run_type: 'http', run_id: runId })
    assert.deepEqual([results.run_id, results.status_filter, results.next_cursor], [runId, 'failed', null])
    const list = await parsed('get_run', { action: 'list', sheet_id: s })
    assert.deepEqual([list.count, list.runs[0].id], [1, runId])
    assert.deepEqual(await parsed('get_run', { action: 'setup', sheet_id: s }), { setup_runs: [] })
  })

  await check('get_run refuses another action\'s fields, a missing one, and a limit past the action\'s', async () => {
    assert.equal(await refusal('get_run', { action: 'status', run_id: runId }), 'status needs run_type.')
    assert.equal(await refusal('get_run', { action: 'list', run_type: 'http' }),
      'run_type is not for list: it takes sheet_id, filter, limit.')
    assert.equal(await refusal('get_run', { action: 'status', run_type: 'http', run_id: runId, cursor: 5 }),
      'cursor is not for status: it takes run_type, run_id, wait_seconds.')
    assert.equal(await refusal('get_run', { action: 'list', limit: 51 }), 'limit for list is 1 to 50.')
    assert.equal(await refusal('get_run', { action: 'setup', limit: 101 }), 'limit for setup is 1 to 100.')
    assert.equal(await refusal('get_run', { action: 'setup' }), 'setup needs setup_run_id or sheet_id.')
    assert.equal((await parsed('get_run', { action: 'results', run_type: 'http', run_id: runId, limit: 500 })).run_id,
      runId)
  })

  await check('get_account: usage, saved_keys and version answer as their tools did; balances asks the network',
    async () => {
      const usage = await parsed('get_account', { action: 'usage', sheet_id: s })
      assert.deepEqual([usage.sheet_id, usage.group_by, typeof usage.rows_total], [s, 'column', 'number'])
      assert.deepEqual(await parsed('get_account', { action: 'saved_keys' }), { keys: [], keys_count: 0 })
      assert.deepEqual(await parsed('get_account', { action: 'version' }), versionInfo(uid))
      assert.match(await refusal('get_account', { action: 'version', since: 'main 1234' }), /^since must/)
      const balances = await call('get_account', { action: 'balances' }, READ)
      assert.doesNotMatch(balances, /not for balances/)
      assert.equal(await refusal('get_account', { action: 'balances', sheet_id: s }),
        'sheet_id is not for balances: it takes nothing else.')
      assert.equal(await refusal('get_account', { action: 'version', name: 'k' }),
        'name is not for version: it takes since.')
    })

  await check('find_enrichments refuses the other action\'s field, and get needs tool_id', async () => {
    assert.equal(await refusal('find_enrichments', { action: 'search', tool_id: 'x' }),
      'tool_id is for get: search takes query.')
    assert.equal(await refusal('find_enrichments', { action: 'get', query: 'email' }),
      'query is for search: get takes tool_id.')
    assert.equal(await refusal('find_enrichments', { action: 'get' }), 'get needs tool_id.')
  })

  await check('get_workspace with all_tables answers list_tables\' answer; get_sheet with history the change log',
    async () => {
      assert.deepEqual(await parsed('get_workspace', { all_tables: true }), { tables: await listTablesWithSheets(uid) })
      assert.ok('tables' in await parsed('get_workspace', {}))
      assert.deepEqual(await parsed('get_sheet', { sheet_id: s, history: true }), readSheetHistory(s, uid, {}))
      assert.equal(await refusal('get_sheet', { sheet_id: s, history: true, include_counts: true }),
        'columns and include_counts are for the details: history takes column, before and limit.')
      assert.equal(await refusal('get_sheet', { sheet_id: s, before: 5 }),
        'column, before and limit are for history: true.')
      assert.equal(await refusal('get_sheet', { sheet_id: 'nope', history: true }), 'Sheet not found')
    })

  done()
}
main().catch(crash)
