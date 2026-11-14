// MCP tool errors at their edges (mcp/next-steps.ts, next-step-lookups.ts), through /mcp in both protocol
// eras: a sheet put in the trash before its table names both trash ids, the table's first, and that one
// restore_from_trash call brings it back; apply_setup's names that the setup doesn't make get the close
// columns it makes, or that the name is one it reads, never the sheet's columns; and the work stays small
// whatever the call sent: the first 5 unknown names get close matches, and 1,000 unknown 200-letter names
// on a sheet of 200 columns of 200 letters answer fast (135 s before the bound, about 0.1 s after).
import assert from 'node:assert/strict'
import dbMod from '../../server/src/lib/db'
import stepsMod from '../../server/src/mcp/next-steps'
import trashMod from '../../server/src/services/trash-sheets'
import { mcpHttpKit } from './mcp-http-kit'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { withNextStep } = stepsMod as typeof import('../../server/src/mcp/next-steps')
const { trashSheet, trashTable } = trashMod as typeof import('../../server/src/services/trash-sheets')

const { ctx, check, done, crash, modern, legacy } = mcpHttpKit('mcp-error-next-steps-edges')
const u = ctx.userId
for (const scope of ['write', 'run'] as const) ctx.scopes.add(scope as never)
const insert = (sql: string, ...values: unknown[]) => db.prepare(sql).run(...values)
insert('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)', 't-crm', u, 'CRM')
insert('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)', 's-leads', 't-crm', u, 'Leads',
  JSON.stringify(['Name', 'Email', 'Company Name']))
// A setup that reads Email and makes Domain.
insert('INSERT INTO setups (id,user_id,name,spec) VALUES (?,?,?,?)', 'st-2', u, 'Domains', JSON.stringify({ v: 1,
  inputs: ['Email'], keys: [], steps: [{ kind: 'clean', name: 'Domain', source: 'Email', cleaner: 'trim', options: {},
    autoRun: false }] }))
// A table of two sheets, for the trash; a sheet of 200 columns of 200 letters, for the work.
insert('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)', 't-pair', u, 'Pairs')
insert('INSERT INTO sheets (id,table_id,user_id,name) VALUES (?,?,?,?)', 's-pair', 't-pair', u, 'Pair')
insert('INSERT INTO sheets (id,table_id,user_id,name) VALUES (?,?,?,?)', 's-keep', 't-pair', u, 'Keep')
let seed = 7
const letters = (n: number) => Array.from({ length: n }, () => {
  seed = (seed * 48271) % 2147483647
  return 'abcdefghijklmnopqrstuvwxyz'[seed % 26]
}).join('')
insert('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)', 's-wide', 't-crm', u, 'Wide',
  JSON.stringify(Array.from({ length: 200 }, () => letters(200))))

// A tool error's words, the same in each era.
async function says(name: string, args: Record<string, unknown>, expected: string) {
  for (const send of [modern, legacy]) {
    const result = JSON.parse((await send('tools/call', { name, arguments: args }, name)).text).result
    assert.equal(result?.isError, true, JSON.stringify(result))
    assert.equal(JSON.parse(result.content[0].text).error, expected)
  }
}

async function main() {
  await check('a sheet put in the trash before its table: both ids, the table first, and that call brings it back',
    async () => {
      const sheetGone = trashSheet(u, 't-pair', 's-pair'), tableGone = trashTable(u, 't-pair')
      assert.ok('ok' in sheetGone && 'ok' in tableGone, JSON.stringify([sheetGone, tableGone]))
      const ids = [tableGone.ok.trashId, sheetGone.ok.trashId]
      await says('read_rows', { sheet_id: 's-pair' }, 'Sheet not found. It is sheet "Pair" (table "Pairs"), which is '
        + `in the trash, and so is its table: restore_from_trash with trash_ids [${ids.join(', ')}] brings them back.`)
      const call = async (name: string, args: Record<string, unknown>) =>
        JSON.parse((await modern('tools/call', { name, arguments: args }, name)).text).result
      const restored = await call('restore_from_trash', { trash_ids: ids })
      const errors = restored.structuredContent.results.map((r: { error?: string }) => r.error)
      assert.deepEqual(errors, [undefined, undefined], JSON.stringify(restored))
      const read = await call('read_rows', { sheet_id: 's-pair' })
      assert.notEqual(read.isError, true, JSON.stringify(read))
    })

  await check('apply_setup naming a column the setup doesn\'t make: the setup\'s close ones, or that it reads it',
    async () => {
      const tail = ' list_setups with setup_id lists the columns each step makes.'
      await says('apply_setup', { sheet_id: 's-leads', setup_id: 'st-2', names: { Domian: 'D2' } },
        `This setup makes no column named "Domian". Close matches: "Domain".${tail}`)
      await says('apply_setup', { sheet_id: 's-leads', setup_id: 'st-2', names: { Email: 'D2' } }, 'This setup makes '
        + `no column named "Email". "Email" is a column it reads (inputs picks which column of the sheet), not one it `
        + `makes.${tail}`)
    })

  await check('the work stays small: the first 5 unknown names get close matches; 1,000 long ones answer fast',
    async () => {
      const near = ['Nam', 'Emal', 'Compny Name', 'Nme', 'Emil', 'Nmae', 'Eamil']
      assert.equal(withNextStep(u, { sheet_id: 's-leads' }, `Unknown column(s): ${near.join(', ')}`),
        `Unknown column(s): ${near.join(', ')}. Close matches: "Name", "Company Name" for "Nam", "Email" for "Emal", `
        + '"Name", "Company Name" for "Compny Name", "Name" for "Nme", "Email" for "Emil". get_sheet lists the '
        + 'sheet\'s columns.')
      // 200 columns of 200 letters and 1,000 unknown names of 200: 135 s before the bound, about 0.1 s after.
      const names = Array.from({ length: 1000 }, () => letters(200))
      const started = performance.now()
      const res = await modern('tools/call', { name: 'read_rows', arguments: { sheet_id: 's-wide', columns: names } },
        'read_rows')
      const ms = performance.now() - started
      assert.match(JSON.parse(JSON.parse(res.text).result.content[0].text).error, /^Unknown column\(s\): /)
      assert.ok(ms < 5000, `${Math.round(ms)} ms`)
    })

  done()
}
main().catch(crash)
