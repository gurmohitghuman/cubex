// manage_sheet_webhook while its sheet is busy (a sort, an import), through /mcp in both protocol eras: get
// reads, as get_sheet does and as REST GET /sheets/:id/webhook does, and every change is refused with the busy
// words, writing nothing, as over REST. The url it answers is absolute, at the address the caller reached
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
    await check('a busy sheet: every change is refused with the busy words, and writes nothing', async () => {
      for (const action of ['turn_off', 'rotate', 'delete']) {
        for (const r of await both({ action })) {
          assert.equal(r.isError, true, `${action}: ${JSON.stringify(r)}`)
          assert.equal(JSON.parse(r.content[0].text).error, busyMessage('sort'))
        }
      }
      for (const r of await both({ action: 'add_field', json_path: '$.email', column: 'Email' })) {
        assert.equal(r.isError, true, JSON.stringify(r))
      }
      assert.equal(enabled(), 1)
      assert.equal((db.prepare('SELECT COUNT(*) n FROM webhook_mappings').get() as { n: number }).n, 0)
    })
  } finally {
    release()
    await sorting
  }
  await check('once it is free, a change goes through', async () => {
    const [first] = await both({ action: 'turn_off' })
    assert.equal(first.structuredContent!.webhook.enabled, false)
    assert.equal(enabled(), 0)
  })
  done()
}
main().catch(crash)
