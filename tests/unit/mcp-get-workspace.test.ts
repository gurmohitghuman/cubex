// get_workspace (services/workspace-overview.ts) through /mcp in both protocol eras, under the strict output
// check: the token with its spend, the daily limit and the default model; the 20 tables and 50 sheets changed
// most recently, never another account's or the trash's, with the totals and a note naming list_tables; rows
// counted only up to 10,000, so a 1M-row sheet answers faster than list_tables, which counts them all; the runs
// and setup runs going now, oldest first, 20 of each, with their counts; and the plans that keep it small,
// migration 059's index among them, its WHERE the same as the statuses a run takes before it ends.
import './strict-output'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import dbMod from '../../server/src/lib/db'
import overviewMod from '../../server/src/services/workspace-overview'
import runListMod from '../../server/src/services/run-list'
import schemaMod from '../../server/src/mcp/output-schema'
import { mcpHttpKit } from './mcp-http-kit'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { OVERVIEW_SQL, workspaceOverview } = overviewMod as typeof import('../../server/src/services/workspace-overview')
const { ACTIVE_STATUSES, ACTIVE_STATUS_SQL } = runListMod as typeof import('../../server/src/services/run-list')
const { STRICT_OUTPUT } = schemaMod as typeof import('../../server/src/mcp/output-schema')

const { ctx, check, done, crash, modern, legacy } = mcpHttpKit('mcp-get-workspace')
const u = ctx.userId
// One row into a table, from its columns and values.
const into = (table: string, row: Record<string, unknown>) => db.prepare(`INSERT INTO ${table} (${Object.keys(row)})
  VALUES (${Object.keys(row).map(() => '?')})`).run(...Object.values(row))
const two = (n: number) => String(n).padStart(2, '0')
const at = (minute: number, second = 0) => `2026-11-01 10:${two(minute)}:${two(second)}`

into('access_tokens', { id: 'tok', user_id: u, name: 'unit', token_hash: 'hash', token_prefix: 'cbx_',
  scopes: '["read"]', spend_cap_micro: 5_000_000 })
into('token_spend', { access_token_id: 'tok', user_id: u, ai_cost_usd: 1.25, enrich_micro: 250_000 })
into('settings', { user_id: u, default_ai_model: 'openai/gpt-4o-mini' })
// 25 small tables of 3 sheets (t24 changed last), a sheet of t0 and a table in the trash, and a table of one
// 1M-row sheet changed after them all. Another account's table counts nowhere.
for (let t = 0; t < 25; t++) {
  into('tables', { id: `t${t}`, user_id: u, name: `Table ${t}`, updated_at: at(t) })
  for (let s = 0; s < 3; s++) {
    into('sheets', { id: `t${t}s${s}`, table_id: `t${t}`, user_id: u, name: `Sheet ${s}`, position: s,
      updated_at: at(t, s), column_order: s === 1 ? '["A","B","A"]' : null, data_version: t * 10 + s })
  }
}
db.prepare('UPDATE sheets SET trash_id = 9 WHERE id = ?').run('t0s0')
into('tables', { id: 'gone', user_id: u, name: 'Gone', trash_id: 8 })
into('sheets', { id: 'gone-s', table_id: 'gone', user_id: u, name: 'G', updated_at: at(59) })
into('users', { id: 'other', password_hash: 'x' })
into('tables', { id: 'theirs', user_id: 'other', name: 'Theirs', updated_at: at(59) })
into('tables', { id: 'big', user_id: u, name: 'Big', updated_at: at(40) })
into('sheets',
  { id: 'big-s', table_id: 'big', user_id: u, name: 'Rows', updated_at: at(40), column_order: '["Email"]' })
const addRows = (sheet: string, n: number) => {
  const row = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  db.transaction(() => { for (let i = 0; i < n; i++) row.run(`${sheet}-${i}`, sheet, u, i, '{}') }).immediate()
}
addRows('big-s', 1_000_000)
addRows('t24s2', 10_000)
addRows('t23s2', 10_001)
addRows('t22s2', 5)

// 22 runs going now (13 AI, 9 HTTP: an auto-run batch, an enrichment), oldest first by created_at; finished runs
// and setup steps' own runs don't count. 21 setup runs going now, one done.
for (let i = 0; i < 13; i++) {
  into('ai_runs', { id: `ai${i}`, sheet_id: 't24s0', user_id: u, column_name: `Col ${i}`, prompt: 'p',
    status: ACTIVE_STATUSES[i % 3], processed_rows: i, total_rows: 100, created_at: at(i * 2) })
}
for (let i = 0; i < 9; i++) {
  into('http_runs', { id: `http${i}`, sheet_id: 't23s0', user_id: u, master_column_name: `Api ${i}`,
    status: 'running', processed_rows: i, total_rows: 50, created_at: at(i * 2 + 1),
    autorun_id: i === 0 ? 'auto-1' : null, config: i === 1 ? '{"enrichment":{"v":1}}' : '{}' })
}
into('ai_runs', { id: 'ai-done', sheet_id: 't24s0', user_id: u, column_name: 'Done', prompt: 'p', status: 'completed',
  created_at: at(0) })
into('ai_runs', { id: 'ai-step', sheet_id: 't24s0', user_id: u, column_name: 'Step', prompt: 'p', status: 'running',
  setup_only: 1, created_at: at(0) })
for (let i = 0; i < 22; i++) {
  into('setup_runs', { id: `sr${i}`, user_id: u, sheet_id: 't24s1', setup_name: `Setup ${i}`, plan: '{}', steps: '[]',
    status: i === 21 ? 'done' : i % 2 ? 'paused' : 'running', created_at: at(i) })
}

type Answer = ReturnType<typeof workspaceOverview> & Record<string, any>
async function call(send: typeof modern | typeof legacy): Promise<{ result: any; ms: number }> {
  const started = performance.now()
  const res = await send('tools/call', { name: 'get_workspace', arguments: {} }, 'get_workspace')
  return { result: JSON.parse(res.text).result, ms: performance.now() - started }
}

async function main() {
  const { result } = await call(modern)
  assert.notEqual(result?.isError, true, JSON.stringify(result))
  const a = result.structuredContent as Answer

  await check('both eras answer the same, and the strict output check passes', async () => {
    assert.equal(STRICT_OUTPUT, true)
    assert.deepEqual((await call(legacy)).result.structuredContent, a)
  })

  await check('the token, its spend and scopes, the daily limit and the default model', () => {
    assert.equal(a.cubex_version, 'unknown')
    assert.deepEqual(a.access_token,
      { name: 'unit', scopes: ['read'], spend_cap_usd: 5, spent_usd: 1.5, left_usd: 3.5 })
    // The account's default limit, $10 a day.
    assert.deepEqual(a.enrichment_daily_limit, { limit_usd: 10, used_today_usd: 0, remaining_usd: 10 })
    assert.equal(a.default_ai_model, 'openai/gpt-4o-mini')
  })

  await check('the 20 tables and 50 sheets changed most recently, the trash and another account left out', () => {
    assert.equal(a.table_count, 26)
    assert.equal(a.sheet_count, 75)
    assert.deepEqual(a.tables.map(t => t.id), ['big', ...Array.from({ length: 19 }, (_, i) => `t${24 - i}`)])
    // Big's sheet and the 49 newest of the others: every sheet of t24..t9, t8's newest, none of t7 or t6.
    assert.deepEqual(a.tables.map(t => t.sheets.length), [1, ...Array(16).fill(3), 1, 0, 0])
    assert.deepEqual(a.tables.map(t => t.sheet_count), [1, ...Array(19).fill(3)])
    assert.deepEqual(a.tables[1].sheets.map(s => s.id), ['t24s0', 't24s1', 't24s2'])
    assert.deepEqual(a.tables[17].sheets.map(s => s.id), ['t8s2'])
    assert.deepEqual(a.tables[1].sheets[1], { id: 't24s1', name: 'Sheet 1', columns: 2, row_count: 0,
      data_version: 241, updated_at: at(24, 1) })
  })

  await check('rows counted up to 10,000: more says row_count_at_least; columns null when not listed yet', () => {
    const sheet = (id: string) => a.tables.flatMap(t => t.sheets).find(s => s.id === id)!
    assert.deepEqual([sheet('big-s').row_count, sheet('big-s').row_count_at_least, sheet('big-s').columns],
      [10_000, true, 1])
    assert.deepEqual([sheet('t24s2').row_count, sheet('t24s2').row_count_at_least], [10_000, undefined])
    assert.deepEqual([sheet('t23s2').row_count, sheet('t23s2').row_count_at_least], [10_000, true])
    assert.deepEqual([sheet('t22s2').row_count, sheet('t22s2').columns, sheet('t22s0').columns], [5, null, 0])
  })

  await check('the runs and setup runs going now, oldest first, 20 of each, and the note', () => {
    assert.equal(a.active_run_count, 22)
    assert.deepEqual(a.active_runs.slice(0, 3), [
      { run_type: 'ai', run_id: 'ai0', sheet_id: 't24s0', column: 'Col 0', status: 'pending', processed_rows: 0,
        total_rows: 100, auto_run: false },
      { run_type: 'http', run_id: 'http0', sheet_id: 't23s0', column: 'Api 0', status: 'running', processed_rows: 0,
        total_rows: 50, auto_run: true },
      { run_type: 'ai', run_id: 'ai1', sheet_id: 't24s0', column: 'Col 1', status: 'running', processed_rows: 1,
        total_rows: 100, auto_run: false },
    ])
    assert.equal(a.active_runs.find(r => r.run_id === 'http1')?.run_type, 'enrichment')
    // ai9 and ai10 close the 20; ai11 and ai12 started last.
    assert.deepEqual(a.active_runs.map(r => r.run_id).slice(-2), ['ai9', 'ai10'])
    assert.equal(a.active_runs.length, 20)
    assert.ok(!a.active_runs.some(r => ['ai-done', 'ai-step', 'ai11', 'ai12'].includes(r.run_id)))
    assert.equal(a.active_setup_run_count, 21)
    assert.deepEqual(a.active_setup_runs[1],
      { setup_run_id: 'sr1', setup: 'Setup 1', sheet_id: 't24s1', status: 'paused' })
    assert.equal(a.active_setup_runs.length, 20)
    assert.equal(a.note, '50 of 75 sheets shown, in 20 of 26 tables: list_tables lists them all. 20 of 22 runs going '
      + 'now shown: list_runs with filter "active" lists them. 20 of 21 setup runs going now shown: get_sheet lists a '
      + 'sheet\'s. get_sheet gives a sheet\'s columns and what fills them; get_balances reads the live treg and '
      + 'OpenRouter balances.')
  })

  await check('an account with nothing yet answers zeros and empty lists', () => {
    const empty = workspaceOverview('nobody')
    assert.deepEqual(empty, { table_count: 0, sheet_count: 0, tables: [], active_run_count: 0, active_runs: [],
      active_setup_run_count: 0, active_setup_runs: [] })
  })

  await check('a 1M-row sheet answers faster than list_tables, which counts every row', async () => {
    const best = async (name: string) => {
      let least = Infinity
      for (let i = 0; i < 3; i++) {
        const started = performance.now()
        await modern('tools/call', { name, arguments: {} }, name)
        least = Math.min(least, performance.now() - started)
      }
      return least
    }
    const [workspace, tables] = [await best('get_workspace'), await best('list_tables')]
    const took = `get_workspace ${workspace.toFixed(1)} ms, list_tables ${tables.toFixed(1)} ms`
    assert.ok(workspace < tables, took)
    console.log(`     ${took}`)
  })

  await check('every read goes through an index: the capped count, and the partial indexes of runs going now', () => {
    const plan = (sql: string, ...args: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as
      Array<{ detail: string }>).map(p => p.detail).join(' | ')
    assert.match(plan(OVERVIEW_SQL.rowCount, 'big-s', u, 10_001),
      /SEARCH rows USING COVERING INDEX \w+ \(sheet_id=\? AND user_id=\?\)/)
    const runs = plan(OVERVIEW_SQL.runs, u, u)
    assert.match(runs, /SCAN ai_runs USING INDEX idx_ai_runs_active/, runs)
    assert.match(runs, /SCAN http_runs USING INDEX idx_http_runs_active/, runs)
    assert.match(plan(OVERVIEW_SQL.setupRuns, u), /SEARCH setup_runs USING INDEX idx_setup_runs_live/)
  })

  await check('migration 059\'s WHERE is the statuses a run takes before it ends, as the CHECK allows them', () => {
    const migration = fs.readFileSync('server/src/db/migrations/059_ai_runs_active.sql', 'utf8')
    assert.ok(migration.includes(`ON ai_runs(sheet_id) WHERE ${ACTIVE_STATUS_SQL};`), migration)
    for (const table of ['ai_runs', 'http_runs']) {
      const sql = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').pluck().get(table) as string
      const allowed = /status TEXT NOT NULL DEFAULT 'pending' CHECK \(status IN \(([^)]*)\)\)/.exec(sql)?.[1]
      assert.deepEqual(allowed?.split(',').map(s => s.replace(/'/g, '').trim()).sort(),
        [...ACTIVE_STATUSES, 'cancelled', 'completed', 'failed'].sort(), table)
    }
  })

  done()
}
main().catch(crash)
