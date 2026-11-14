// MCP tool errors say what to send next (mcp/error-answers.ts, next-steps.ts), through /mcp in both
// protocol eras: an unknown sheet, table, column, run or setup gets the caller's close matches (names and
// ids) and the tool that lists them, or that it is in the trash; a missing scope says how to get a token
// with it; the other not-found errors name the tool that lists. The tool's own words stay first. Then, on
// withNextStep and answered alone: a value that exists, or an error already suggesting, is left as it was;
// errWith's structuredContent says the same; and every read a next step makes goes through an index, never
// the rows (but the 4 that tell a brand-new sheet). A transfer into a column the destination lacks gets its
// close ones and the ways on; into a brand-new sheet, only column_mode create_missing. (A table and
// a sheet both in the trash, apply_setup's names and the bound on the work: mcp-error-next-steps-edges.test.ts.)
import assert from 'node:assert/strict'
import dbMod from '../../server/src/lib/db'
import stepsMod from '../../server/src/mcp/next-steps'
import answersMod from '../../server/src/mcp/error-answers'
import { mcpHttpKit } from './mcp-http-kit'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { withNextStep } = stepsMod as typeof import('../../server/src/mcp/next-steps')
const { answered } = answersMod as typeof import('../../server/src/mcp/error-answers')

const { ctx, check, done, crash, modern, legacy } = mcpHttpKit('mcp-error-next-steps')
const u = ctx.userId
const RUN = 'c2f1a9e4-5b7d-4e21-9a3c-1f0e8d7b6a54'
const insert = (sql: string, ...values: unknown[]) => db.prepare(sql).run(...values)
insert('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)', 't-crm', u, 'CRM')
insert('INSERT INTO tables (id,user_id,name,trash_id) VALUES (?,?,?,?)', 't-old', u, 'Archive', 5)
insert('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)', 's-leads', 't-crm', u, 'Leads',
  JSON.stringify(['Name', 'Email', 'Company Name']))
insert('INSERT INTO sheets (id,table_id,user_id,name,trash_id) VALUES (?,?,?,?,?)', 's-old', 't-crm', u, 'Old leads', 7)
insert('INSERT INTO sheets (id,table_id,user_id,name) VALUES (?,?,?,?)', 's-raw', 't-crm', u, 'Raw')
// A brand-new sheet: only the starter column, and its 3 blank rows.
insert('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)', 's-new', 't-crm', u, 'New',
  JSON.stringify(['Column 1']))
for (let i = 0; i < 3; i++) {
  insert('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)', `r-new-${i}`, 's-new', u, i,
    JSON.stringify({ 'Column 1': '' }))
}
insert('INSERT INTO ai_runs (id,sheet_id,user_id,column_name,prompt) VALUES (?,?,?,?,?)', RUN, 's-leads', u,
  'Summary', 'p')
insert('INSERT INTO setups (id,user_id,name,spec) VALUES (?,?,?,?)', 'st-1', u, 'Lead enrichment', '{}')

// A tool error's words, in each era.
async function errorOf(name: string, args: Record<string, unknown>): Promise<string[]> {
  const words: string[] = []
  for (const send of [modern, legacy]) {
    const res = await send('tools/call', { name, arguments: args }, name)
    const result = JSON.parse(res.text).result
    assert.equal(result?.isError, true, `${name} ${res.text.slice(0, 300)}`)
    words.push(JSON.parse(result.content[0].text).error)
  }
  assert.equal(words[0], words[1], 'both eras say the same')
  return words.slice(0, 1)
}
const says = async (name: string, args: Record<string, unknown>, expected: string) =>
  assert.deepEqual(await errorOf(name, args), [expected])

async function main() {
  await check('a missing scope names it and says how to get a token with it', () => says('append_rows',
    { sheet_id: 's-leads', rows: [{ Name: 'x' }] }, "This action requires the 'write' scope on your Cubex access "
    + "token. A token's scopes are set when it is made: the user can make a token with Write ticked in Cubex "
    + '(Settings, then Agent access) and connect with it.'))
  for (const scope of ['write', 'run'] as const) ctx.scopes.add(scope as never)

  await check('an unknown sheet: a name sent as its id, in the trash, nothing close', async () => {
    await says('get_sheet', { sheet_id: 'leads' }, 'Sheet not found. No sheet has the sheet_id "leads". Close '
      + 'matches: "Leads" (sheet_id "s-leads", table "CRM"). list_tables lists every table and sheet with their ids.')
    await says('read_rows', { sheet_id: 's-old' }, 'Sheet not found. It is sheet "Old leads" (table "CRM"), which is '
      + 'in the trash: restore_from_trash with trash_ids [7] brings it back.')
    await says('read_rows', { sheet_id: 'Payroll' }, 'Sheet not found. No sheet has the sheet_id "Payroll". '
      + 'list_tables lists every table and sheet with their ids.')
  })

  await check('the sheet a transfer names that is unknown, and an unknown table, one in the trash', async () => {
    await says('transfer_rows', { source_sheet_id: 's-leads', destination_sheet_id: 'Leeds', operation: 'copy',
      selection: { all: true }, idempotency_key: 'k1' }, 'Source or destination sheet not found. No sheet has the '
      + 'destination_sheet_id "Leeds". Close matches: "Leads" (sheet_id "s-leads", table "CRM"). list_tables lists '
      + 'every table and sheet with their ids.')
    await says('manage_sheet', { action: 'create', table_id: 'crm', name: 'x' }, 'Table not found. No table has the '
      + 'table_id "crm". Close matches: "CRM" (table_id "t-crm"). list_tables lists every table with its id.')
    await says('manage_sheet', { action: 'create', table_id: 't-old', name: 'x' }, 'Table not found. It is table '
      + '"Archive", which is in the trash: restore_from_trash with trash_ids [5] brings it back.')
  })

  await check('an unknown column gets the sheet\'s close ones, any case or spelling', async () => {
    await says('read_rows', { sheet_id: 's-leads', columns: ['Emial'] }, 'Unknown column(s): Emial. Close matches: '
      + '"Email" for "Emial". get_sheet lists the sheet\'s columns.')
    await says('get_sheet', { sheet_id: 's-leads', columns: ['company name'] }, 'This sheet has no column named '
      + '"company name". Close matches: "Company Name" for "company name". get_sheet lists the sheet\'s columns.')
  })

  await check('an unknown run: one of another kind, a mistyped id, and an unknown setup', async () => {
    await says('get_run_status', { run_type: 'enrichment', run_id: RUN }, `Enrichment run not found. run_id "${RUN}" `
      + 'is an AI run: call again with run_type "ai".')
    await says('get_run_status', { run_type: 'ai', run_id: RUN.slice(0, -1) }, 'Run not found. No run has the run_id '
      + `"${RUN.slice(0, -1)}". Close matches: "${RUN}" (an AI run filling "Summary" on "Leads"). list_runs lists `
      + 'a sheet\'s runs, newest first.')
    await says('list_setups', { setup_id: 'Lead enrichment' }, 'Setup not found. No saved setup has the setup_id '
      + '"Lead enrichment". Close matches: "Lead enrichment" (setup_id "st-1"). list_setups lists the saved setups '
      + 'with their ids.')
  })

  await check('other unknown ids name the tool that lists them', async () => {
    await says('get_setup_run', { setup_run_id: 'x' }, 'Setup run not found. get_setup_run with sheet_id lists the '
      + 'setup runs on a sheet.')
    await says('list_run_webhooks', { webhook_id: 'x' }, 'Run webhook not found. list_run_webhooks lists the '
      + 'webhooks with their ids.')
  })

  await check('left as it was: a value that exists, an error already suggesting or naming its tool', () => {
    const older = 's-older-than-the-newest-500'
    insert('INSERT INTO sheets (id,table_id,user_id,name) VALUES (?,?,?,?)', older, 't-crm', u, 'Older')
    const many = db.prepare('INSERT INTO sheets (id,table_id,user_id,name) VALUES (?,?,?,?)')
    db.transaction(() => { for (let i = 0; i < 501; i++) many.run(`s-${i}`, 't-crm', u, `Sheet ${i}`) }).immediate()
    for (const [args, message] of [
      [{ sheet_id: older }, 'Sheet not found'],
      [{ run_type: 'ai', run_id: RUN }, 'Run not found'],
      [{ setup_id: 'st-1' }, 'Setup not found'],
      [{ sheet_id: 's-leads' }, 'There\'s no column named "Emial". Did you mean "Email"?'],
      [{ sheet_id: 's-leads' }, 'Pass setup_run_id or sheet_id.'],
      [{}, 'Something went wrong handling that request. Please try again.'],
    ] as const) assert.equal(withNextStep(u, args, message), message)
    assert.equal(withNextStep(u, { run_id: 'nope' }, 'Run not found. list_runs shows the runs of a sheet.'),
      'Run not found. list_runs shows the runs of a sheet. No run has the run_id "nope".')
    assert.equal(withNextStep(u, { sheet_id: 's-raw' }, 'Unknown column(s): Emial'),
      'Unknown column(s): Emial. get_sheet lists the sheet\'s columns.')
    assert.equal(withNextStep(u, {}, "This run references saved API key(s): k. Re-running it requires the 'secrets' "
      + 'scope.'), "This run references saved API key(s): k. Re-running it requires the 'secrets' scope. A token's "
      + 'scopes are set when it is made: the user can make a token with Use saved API keys ticked in Cubex (Settings, '
      + 'then Agent access) and connect with it.')
  })

  await check('an error with structuredContent says the same there; a result that isn\'t an error is as it was', () => {
    const data = { error: 'Sheet not found', rows_done: 3 }
    const result = { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data,
      isError: true as const }
    const out = answered(u, 'transform_column', { sheet_id: 'leads' }, result)
    assert.equal((out.structuredContent as typeof data).error, JSON.parse(out.content[0].text).error)
    assert.match((out.structuredContent as typeof data).error, /^Sheet not found\. No sheet has the sheet_id "leads"/)
    assert.equal((out.structuredContent as typeof data).rows_done, 3)
    const fine = { content: [{ type: 'text' as const, text: '{"error":"Sheet not found"}' }] }
    assert.equal(answered(u, 'get_sheet', { sheet_id: 'leads' }, fine), fine)
  })

  await check('every read a next step makes goes through an index or a key, and none reads the rows', () => {
    // But one: telling a brand-new destination sheet reads its first 4 rows (services/transfer-seed.ts), by index.
    const seen: string[] = []
    const prepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => { seen.push(sql); return prepare(sql) }) as typeof db.prepare
    try {
      for (const [args, message] of [[{ sheet_id: 'x' }, 'Sheet not found'], [{ table_id: 'x' }, 'Table not found'],
        [{ setup_id: 'x' }, 'Setup not found'], [{ run_id: 'x' }, 'Run not found'],
        [{ setup_id: 'st-1' }, 'This setup makes no column named "x".'],
        [{ sheet_id: 's-leads' }, 'Unknown column(s): x'],
        [{ destination_sheet_id: 's-leads' }, 'Unknown destination column: x'],
        [{ destination_sheet_id: 's-new' }, 'Unknown destination column: x']] as const) withNextStep(u, args, message)
    } finally { db.prepare = prepare }
    assert.ok(seen.length >= 8, `${seen.length} reads`)
    for (const sql of seen) {
      const plan = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...sql.split('?').slice(1).map(() => 'x')) as
        Array<{ detail: string }>).map(p => p.detail)
      assert.ok(plan.every(d => !/^SCAN /.test(d)), `${sql}\n${plan.join('\n')}`)
      assert.ok(!/\brows\b/.test(sql) || /\bLIMIT \?$/.test(sql.trim()), sql)
    }
  })

  // Its own source sheet: Leads has a run that hasn't ended, and a transfer waits for that first.
  await check('a transfer into a column the destination lacks: its close ones, and the three ways on', async () => {
    const sheet = (id: string, name: string, columns: string[]) => insert('INSERT INTO sheets '
      + '(id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)', id, 't-crm', u, name, JSON.stringify(columns))
    sheet('s-in', 'March', ['Name', 'Email'])
    sheet('s-out', 'Outreach', ['Name', 'E-mail'])
    insert('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)', 'r-1', 's-in', u, 0,
      JSON.stringify({ Name: 'Ada', Email: 'ada@acme.com' }))
    await says('transfer_rows', { source_sheet_id: 's-in', destination_sheet_id: 's-out', operation: 'copy',
      selection: { all: true }, columns: ['Name', 'Email'], column_mode: 'require_existing', idempotency_key: 'k2' },
    'Unknown destination column: Email. Close matches in the destination: "E-mail". To copy only the columns it '
      + 'has, list them in columns (or send this one to another with column_mapping); column_mode "create_missing" '
      + 'adds it.')
  })

  await check('a transfer into a brand-new sheet gives only column_mode create_missing', async () => {
    await says('transfer_rows', { source_sheet_id: 's-in', destination_sheet_id: 's-new', operation: 'copy',
      selection: { all: true }, columns: ['Name'], column_mode: 'require_existing', idempotency_key: 'k3' },
    'Unknown destination column: Name. The destination is a new, empty sheet: column_mode "create_missing" adds '
      + 'the columns.')
  })
  done()
}
main().catch(crash)
