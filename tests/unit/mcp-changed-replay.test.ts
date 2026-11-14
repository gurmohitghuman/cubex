// A keyed write's replay, and rows counted with auto-dedupe on (server/src/mcp/changed.ts). A keyed write keeps
// its changed with its key, in its transaction: a replay answers it as the first call did, with the versions the
// sheet had then, though the sheet changed since. Here for append_rows, update_cells in both forms and
// transfer_rows; the run starts' replay tests (token-replay-first-*.test.ts) hold it for theirs. A key first used
// over REST replays over MCP with the changed the REST call kept, and an entry kept before keys held one answers
// []. With auto-dedupe on, rows and row_ids follow what the sheet now holds, with keep oldest and keep newest:
// append_rows, transfer_rows, update_cells and import_csv. Rows arriving where an auto-run is on: more_coming.
import './strict-output'
import assert from 'node:assert/strict'
import dbMod from '../../server/src/lib/db'
import keyedMod from '../../server/src/services/rows-write-keyed'
import indexMod from '../../server/src/services/auto-dedupe-index'
import { mcpHttpKit } from './mcp-http-kit'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { appendRowsKeyed } = keyedMod as typeof import('../../server/src/services/rows-write-keyed')
const { maintainAutoDedupeSheet } = indexMod as typeof import('../../server/src/services/auto-dedupe-index')

const { ctx, check, done, crash, modern } = mcpHttpKit('mcp-changed-replay')
const u = ctx.userId
ctx.scopes.add('write' as never)

type Item = { sheet_id: string; columns: string[]; rows: number; row_ids?: string[]; data_version: number;
  more_coming?: true }
type Answer = Record<string, unknown> & { changed: Item[] }
type Dedupe = { not_kept: string[]; replaced: string[]; replaced_count: number }

async function call(name: string, args: Record<string, unknown>): Promise<Answer> {
  const res = await modern('tools/call', { name, arguments: args }, name)
  const result = JSON.parse(res.text).result
  assert.notEqual(result?.isError, true, `${name}: ${JSON.stringify(result)}`)
  return result.structuredContent as Answer
}
const dataVersion = (sheet: string) =>
  db.prepare('SELECT data_version FROM sheets WHERE id = ?').pluck().get(sheet) as number
const idOf = (sheet: string, email: string) => db.prepare(`SELECT id FROM rows WHERE sheet_id = ?
  AND json_extract(data, '$.Email') = ?`).pluck().get(sheet, email) as string
const idsOf = (a: Answer) => (a.rows as Array<{ id: string }>).map(r => r.id)
const named = (a: Answer) => a.changed.map(i => [i.sheet_id, i.rows, i.row_ids])

async function sheetWith(name: string, emails: string[]): Promise<string> {
  const t = await call('manage_table', { action: 'create', name })
  const sheet = (t.sheets as Array<{ id: string }>)[0].id
  for (const column of ['Email', 'Name']) await call('add_column', { sheet_id: sheet, name: column })
  if (emails.length) await call('append_rows', { sheet_id: sheet, rows: emails.map(Email => ({ Email })) })
  return sheet
}
const moveOn = (sheet: string) => call('append_rows', { sheet_id: sheet, rows: [{ Email: 'later@x.com' }] })
async function dedupe(sheet: string, keep: string) {
  await call('set_auto_dedupe', { sheet_id: sheet, column: 'Email', keep })
  assert.equal(await maintainAutoDedupeSheet(sheet, u, Date.now() + 10_000), 'ready')
}

// The call, a write that moves `sheet` on, the same call again: the first call's changed, versions and all.
async function replaysFirst(name: string, args: Record<string, unknown>, sheet: string): Promise<Answer> {
  const first = await call(name, args)
  assert.ok(first.changed.length > 0 && first.replayed === false, `${name}: ${JSON.stringify(first)}`)
  await moveOn(sheet)
  assert.ok(dataVersion(sheet) > first.changed[0].data_version, `${name}: the sheet moved on`)
  const again = await call(name, args)
  assert.equal(again.replayed, true, name)
  assert.deepEqual(again.changed, first.changed, `${name}: the first call's changed`)
  return first
}

async function main() {
  await check('append_rows, update_cells (both forms), transfer_rows: a replay answers the first changed', async () => {
    const s = await sheetWith('Replays', [])
    const a = await replaysFirst('append_rows',
      { sheet_id: s, rows: [{ Email: 'a@x.com' }, { Email: 'b@x.com' }], idempotency_key: 'r-ap' }, s)
    const ids = idsOf(a)
    assert.deepEqual(named(a), [[s, 2, ids]])
    await replaysFirst('update_cells', { row_id: ids[0], data: { Name: 'Ann' }, idempotency_key: 'r-up' }, s)
    await replaysFirst('update_cells', { sheet_id: s, idempotency_key: 'r-bt',
      updates: [{ row_id: ids[0], data: { Name: 'A' } }, { row_id: ids[1], data: { Name: 'B' } }] }, s)
    const d = await sheetWith('Replays to', [])
    await replaysFirst('transfer_rows', { source_sheet_id: s, destination_sheet_id: d, operation: 'copy',
      selection: { row_ids: ids }, columns: ['Email'], idempotency_key: 'r-tr' }, d)
  })

  await check('a key first used over REST replays over MCP with the changed the REST call kept', async () => {
    const s = await sheetWith('Over REST', [])
    const r = appendRowsKeyed(s, u, [{ Email: 'r@x.com' }], 'r-rest', 'rest')
    assert.ok(!('fail' in r) && !('changed' in r.ok.answer), 'the REST answer has no changed')
    assert.deepEqual(r.changed.map(i => [i.sheet_id, i.columns, i.rows, i.row_ids]),
      [[s, ['Email'], 1, [r.ok.answer.rows[0].id]]])
    await moveOn(s)
    const again = await call('append_rows', { sheet_id: s, rows: [{ Email: 'r@x.com' }], idempotency_key: 'r-rest' })
    assert.deepEqual(again.changed, r.changed)
  })

  await check('an entry kept before keys held changed answers []', async () => {
    const s = await sheetWith('Older key', [])
    const args = { sheet_id: s, rows: [{ Email: 'o@x.com' }], idempotency_key: 'r-old' }
    await call('append_rows', args)
    db.prepare(`UPDATE data_operation_ledger SET result_json = json_remove(result_json, '$.changed')
      WHERE user_id = ? AND idempotency_key = ?`).run(u, 'r-old')
    assert.deepEqual((await call('append_rows', args)).changed, [])
  })

  for (const keep of ['oldest', 'newest'] as const) {
    await check(`keep ${keep}: append_rows counts the rows the sheet now holds`, async () => {
      const s = await sheetWith(`Append ${keep}`, ['a@x.com'])
      const old = idOf(s, 'a@x.com')
      await dedupe(s, keep)
      const a = await call('append_rows', { sheet_id: s, rows: [{ Email: 'a@x.com' }, { Email: 'b@x.com' }] })
      const [newA, newB] = idsOf(a)
      const d = a.auto_dedupe as Dedupe
      // Oldest: the new a@x.com went straight to the trash. Newest: it replaced the old one, which left.
      assert.deepEqual(keep === 'oldest' ? d.not_kept : d.replaced, keep === 'oldest' ? [newA] : [old])
      assert.deepEqual(named(a), [[s, keep === 'oldest' ? 1 : 3, keep === 'oldest' ? [newB] : [newA, newB, old]]])
    })

    await check(`keep ${keep}: transfer_rows counts the rows the destination now holds`, async () => {
      const src = await sheetWith(`From ${keep}`, ['a@x.com', 'b@x.com'])
      const dest = await sheetWith(`Into ${keep}`, ['a@x.com'])
      const old = idOf(dest, 'a@x.com')
      await dedupe(dest, keep)
      const t = await call('transfer_rows', { source_sheet_id: src, destination_sheet_id: dest, operation: 'copy',
        selection: { all: true }, columns: ['Email'], idempotency_key: `t-${keep}` })
      const b = idOf(dest, 'b@x.com')
      assert.deepEqual(named(t), [[dest, keep === 'oldest' ? 1 : 3,
        keep === 'oldest' ? [b] : [idOf(dest, 'a@x.com'), b, old]]])
    })

    await check(`keep ${keep}: import_csv leaves out the rows not kept and counts the ones replaced`, async () => {
      const s = await sheetWith(`Import ${keep}`, ['a@x.com'])
      await dedupe(s, keep)
      const a = await call('import_csv', { sheet_id: s, csv: 'Email\na@x.com\nc@x.com\n' })
      assert.deepEqual(a.changed.map(i => i.rows), [keep === 'oldest' ? 1 : 3])
    })
  }

  await check('update_cells names the rows auto-dedupe replaced with its edit, after its own', async () => {
    const s = await sheetWith('Edits', ['a@x.com', 'b@x.com'])
    const [a, b] = [idOf(s, 'a@x.com'), idOf(s, 'b@x.com')]
    await dedupe(s, 'newest')
    const one = await call('update_cells', { row_id: b, data: { Email: 'a@x.com' } })
    const d = one.auto_dedupe as Dedupe
    assert.deepEqual(d.replaced, [a], JSON.stringify(one))
    assert.deepEqual(named(one), [[s, 2, [b, a]]])
  })

  await check('rows arriving where an auto-run is on answer more_coming', async () => {
    const s = await sheetWith('Auto-run', ['a@x.com'])
    await call('formula_column', { sheet_id: s, column: 'Domain', formula: "{{Email}}.split('@')[1]" })
    const on = db.prepare('SELECT COUNT(*) FROM autorun_columns WHERE sheet_id = ? AND enabled = 1').pluck().get(s)
    assert.equal(on, 1, 'the formula column follows new rows')
    const a = await call('append_rows', { sheet_id: s, rows: [{ Email: 'n@x.com' }] })
    assert.equal(a.changed[0].more_coming, true)
  })

  done()
}

main().catch(crash)
