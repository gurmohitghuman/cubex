// The tool hints a single call can't show (mcp-tool-hints.test.ts has the rest):
//   - append_rows and add_list_rows can replace a row already there: on a sheet
//     whose auto-dedupe keeps the newest row per key, an arriving row with a key
//     the sheet has sends the older row to the trash. So both say destructiveHint
//     true (they said false).
//   - write_formula and write_run_condition change no row, cell, column or setup:
//     each asks the model (a stand-in for OpenRouter on 127.0.0.1) and answers
//     with what it wrote. Not read-only: the call is spent, and the usage history
//     keeps it.
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { v4 as uuid } from 'uuid'

const MODEL = 'openai/gpt-4o-mini'
let reply = ''
const standIn = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET') {
      res.end(JSON.stringify({ data: [{ id: MODEL, name: MODEL, pricing: { prompt: '0.000001', completion: '0' } }] }))
      return
    }
    res.end(JSON.stringify({ id: 'gen-1', object: 'chat.completion', created: 0, model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: 0.0001 } }))
  })
})
await new Promise<void>(resolve => standIn.listen(0, '127.0.0.1', resolve))
process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(standIn.address() as AddressInfo).port}/api/v1`

const { toolHintsKit } = await import('./mcp-tool-hints-kit')
const { setAutoDedupe } = await import('../../server/src/services/auto-dedupe-setting')
const { maintainAutoDedupeSheet } = await import('../../server/src/services/auto-dedupe-index')
const { addListItems } = await import('../../server/src/services/enrich-list-add')
const { encrypt } = await import('../../server/src/lib/crypto')
const { db, uid, sheet, call, hints, snapshot, check, done, crash } = toolHintsKit('mcp-tool-hints-writes')
const ALL = ['read', 'write', 'run', 'secrets'] as const

const names = (s: string) => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index')
  .pluck().all(s) as string[]).map(d => JSON.parse(d).Name)
// Auto-dedupe on `column`, keeping the newest row per key, its keys built.
async function keepNewest(s: string, column: string) {
  assert.ok('ok' in setAutoDedupe(uid, s, { column, keep: 'newest' }))
  assert.equal(await maintainAutoDedupeSheet(s, uid, Date.now() + 10_000), 'ready')
}

async function main() {
  await check('append_rows replaces a row whose key the sheet has: destructive', async () => {
    const s = sheet('Leads', ['Email', 'Name'],
      [{ Email: 'ann@x.com', Name: 'Ann (old)' }, { Email: 'bo@x.com', Name: 'Bo' }])
    await keepNewest(s, 'Email')
    const answer = await call('append_rows', { sheet_id: s, rows: [{ Email: 'ann@x.com', Name: 'Ann (new)' }] }, ALL)
    assert.doesNotMatch(answer, /^ERROR/)
    assert.deepEqual(names(s).sort(), ['Ann (new)', 'Bo'], 'the older Ann went to the trash')
    const trashed = db.prepare(`SELECT r.data FROM trash_rows r JOIN trash_items t ON t.id = r.item_id
      WHERE t.user_id = ?`).pluck().all(uid) as string[]
    assert.deepEqual(trashed.map(d => JSON.parse(d).Name), ['Ann (old)'])
    assert.equal(hints.append_rows.destructiveHint, true)
  })

  await check('add_list_rows replaces a row whose key the sheet has: destructive', async () => {
    const src = sheet('Companies', ['Company', 'People'], [{ Company: 'Co', People: '➕ Adding 1 row…' }])
    const srcRow = db.prepare('SELECT id FROM rows WHERE sheet_id = ?').pluck().get(src) as string
    const dest = sheet('People', ['Company', 'Name'], [{ Company: 'Co', Name: 'Ann' }])
    await keepNewest(dest, 'Name')
    const run = uuid(), journal = uuid()
    const list = { destSheetId: dest, itemsPath: '$.output.people', provider: null, maxItems: 10,
      fields: [{ path: '$.name', columnName: 'Name' }], copy: [{ id: 'c1', from: 'Company', to: 'Company' }],
      dedupe: null }
    db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, master_column_name,
      dest_sheet_id) VALUES (?, ?, ?, ?, 'completed', 0, 'People', ?)`).run(run, src, uid,
      JSON.stringify({ requestConfig: {}, responseMapping: [], enrichment: { v: 1, list } }), dest)
    db.prepare(`INSERT INTO enrichment_list_items (id, user_id, run_id, source_sheet_id, source_row_id,
      dest_sheet_id, items_json, item_count) VALUES (?,?,?,?,?,?,?,?)`).run(journal, uid, run, src, srcRow, dest,
      JSON.stringify({ items: [{ name: 'ann' }], copy: { c1: 'Co' } }), 1)
    // The step add_list_rows sets off: the journal's results land as rows (enrich-list-add.ts).
    const out = addListItems(journal)
    assert.deepEqual(out, { added: 1, skipped: 0 })
    assert.deepEqual(names(dest), ['ann'], 'the row already there went to the trash')
    assert.equal(hints.add_list_rows.destructiveHint, true)
  })

  await check('write_formula and write_run_condition change no row, cell, column or setup', async () => {
    db.prepare('INSERT INTO settings (id, user_id, openrouter_api_key_encrypted) VALUES (?,?,?)')
      .run(uuid(), uid, encrypt('sk-or-test'))
    const s = sheet('Contacts', ['Name', 'Email'], [{ Name: 'Ann', Email: 'ann@x.com' }, { Name: 'Bo', Email: '' }])
    const before = snapshot()
    reply = '{{Email}}'
    const formula = await call('write_formula', { sheet_id: s, words: 'the email', model: MODEL }, ALL)
    assert.match(formula, /^\{.*"formula":"\{\{Email\}\}"/)
    reply = '{{Email}} is not empty'
    const rule = await call('write_run_condition', { sheet_id: s, text: 'rows with an email', model: MODEL }, ALL)
    assert.doesNotMatch(rule, /^ERROR/)
    assert.deepEqual(snapshot(), before)
    for (const name of ['write_formula', 'write_run_condition']) {
      assert.deepEqual([hints[name].readOnlyHint, hints[name].destructiveHint], [false, false], name)
    }
  })

  standIn.close()
  done()
}

main().catch(crash)
