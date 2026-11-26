// manage_sheet_webhook while its sheet is busy (a sort, an import), through /mcp in both protocol eras: get
// reads, as get_sheet does and as REST GET /sheets/:id/webhook does; a change to its columns (add_field,
// remove_field) is refused with the busy words, writing nothing, as over REST; and its own controls (turn_off,
// turn_on, rotate) go through, so a leaked URL can be cut off mid-import (lib/sheet-busy.ts webhookControl).
// The url it answers is absolute, at the address the caller reached
// Cubex on (ctx.linkBase), so an agent can paste it into a sender.
import assert from 'node:assert/strict'
import dbMod from '../../server/src/lib/db'
import busyMod from '../../server/src/lib/sheet-busy'
import whMod from '../../server/src/lib/webhook-service'
import { mcpHttpKit } from './mcp-http-kit'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { withSheetBusy, busyMessage } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { createSourceWithColumn } = whMod as typeof import('../../server/src/lib/webhook-service')

const { ctx, check, done, crash, modern, legacy } = mcpHttpKit('mcp-sheet-webhook-busy')
ctx.scopes.add('write' as never)
;(ctx as { linkBase?: string }).linkBase = 'https://cubex.example.com'
const u = ctx.userId
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run('t-hooks', u, 'Hooks')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,column_order) VALUES (?,?,?,?,?)')
  .run('s-hook', 't-hooks', u, 'Events', JSON.stringify(['Name']))
createSourceWithColumn('s-hook', u, 'Webhook')
db.prepare(`INSERT INTO webhook_mappings (id, source_id, user_id, json_path, column_name)
  SELECT 'f-name', id, user_id, '$.name', 'Name' FROM webhook_sources WHERE sheet_id = ?`).run('s-hook')

type Result = { isError?: boolean; structuredContent?: Record<string, any>; content: Array<{ text: string }> }
async function both(args: Record<string, unknown>): Promise<Result[]> {
  const out: Result[] = []
  for (const send of [modern, legacy]) {
    const name = 'manage_sheet_webhook'
    out.push(JSON.parse((await send('tools/call', { name, arguments: { sheet_id: 's-hook', ...args } }, name)).text)
      .result)
  }
  return out
}
const tokenHash = () => db.prepare('SELECT token_hash FROM webhook_sources WHERE sheet_id = ?').pluck()
  .get('s-hook') as string
const fields = () => db.prepare('SELECT COUNT(*) FROM webhook_mappings').pluck().get() as number
const enabled = () => (db.prepare('SELECT enabled FROM webhook_sources WHERE sheet_id = ?').get('s-hook') as
  { enabled: number }).enabled

async function main() {
  await check('the url is absolute, at the address the caller reached Cubex on', async () => {
    for (const r of await both({ action: 'get' })) {
      assert.equal(r.isError, undefined, JSON.stringify(r))
      assert.match(r.structuredContent!.webhook.url, /^https:\/\/cubex\.example\.com\/api\/webhooks\/[\w-]+$/)
    }
  })

  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const sorting = withSheetBusy('s-hook', 'sort', () => held)
  try {
    await check('a busy sheet: get still reads', async () => {
      for (const r of await both({ action: 'get' })) {
        assert.equal(r.isError, undefined, JSON.stringify(r))
        assert.equal(r.structuredContent!.webhook.enabled, true)
      }
    })
    await check('a busy sheet: a change to its columns is refused with the busy words, writing nothing', async () => {
      for (const args of [{ action: 'add_field', json_path: '$.email', column: 'Email' },
        { action: 'remove_field', field_id: 'f-name' }]) {
        for (const r of await both(args)) {
          assert.equal(r.isError, true, `${args.action}: ${JSON.stringify(r)}`)
          assert.equal(JSON.parse(r.content[0].text).error, busyMessage('sort'))
        }
      }
      assert.equal(fields(), 1)
    })
    await check('a busy sheet: its own controls go through (turn_off, turn_on, rotate)', async () => {
      for (const r of await both({ action: 'turn_off' })) assert.equal(r.structuredContent?.webhook.enabled, false)
      assert.equal(enabled(), 0)
      for (const r of await both({ action: 'turn_on' })) assert.equal(r.structuredContent?.webhook.enabled, true)
      const before = tokenHash()
      for (const r of await both({ action: 'rotate' })) assert.equal(r.isError, undefined, JSON.stringify(r))
      assert.notEqual(tokenHash(), before)
    })
  } finally {
    release()
    await sorting
  }
  await check('once it is free, a change to its columns goes through', async () => {
    const [first] = await both({ action: 'add_field', json_path: '$.email', column: 'Email' })
    assert.equal(first.isError, undefined, JSON.stringify(first))
    assert.equal(fields(), 2)
  })
  done()
}
main().catch(crash)
