// get_sheet's include_counts over MCP, past the first counting slice (4,000
// rows, FILTER_SLICE_ROWS): the handler as registered (scope check, error
// wrapper) reads the SDK's request context. A live request counts every row; a
// cancelled one (the SDK's mcpReq.signal) or a hung-up one (the token's
// abortSignal, which an initialize-era client's hang-up aborts) stops after the
// first slice and answers without counts, never with an error.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import readMod from '../../server/src/mcp/tools-read'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { registerReadTools } = readMod as typeof import('../../server/src/mcp/tools-read')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

const ROWS = 4_001
const uid = uuid(), tid = uuid(), sid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,0,?)')
  .run(sid, tid, uid, 'S', JSON.stringify(['val']))
const insert = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
db.transaction(() => {
  for (let i = 0; i < ROWS; i++) insert.run(uuid(), sid, uid, i, JSON.stringify({ val: `v${i}` }))
})()

type Handler = (args: unknown, mcp: ServerContext) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
const handlers: Record<string, Handler> = {}
const fakeServer = { registerTool: (name: string, _config: unknown, h: Handler) => { handlers[name] = h } }

async function getSheet(opts: { cancelled?: boolean; hungUp?: boolean }) {
  const hangUp = new AbortController()
  if (opts.hungUp) hangUp.abort()
  registerReadTools(fakeServer as unknown as McpServer,
    { userId: uid, tokenId: 't', tokenName: 'n', scopes: new Set(['read']), abortSignal: hangUp.signal })
  const cancel = new AbortController()
  if (opts.cancelled) cancel.abort()
  const res = await handlers.get_sheet({ sheet_id: sid, include_counts: true },
    { mcpReq: { signal: cancel.signal } } as unknown as ServerContext)
  const body = JSON.parse(res.content[0].text)
  assert.ok(!res.isError, `get_sheet answered an error: ${res.content[0].text}`)
  assert.equal(body.row_count, ROWS)
  return body.column_details[0].counts
}

async function main() {
  assert.deepEqual(await getSheet({}), { filled: ROWS, empty: 0, errors: 0 })
  console.log('ok   a live request counts all 4,001 rows')
  assert.equal(await getSheet({ cancelled: true }), null)
  console.log('ok   a cancelled request stops counting and answers without counts')
  assert.equal(await getSheet({ hungUp: true }), null)
  console.log('ok   a hung-up request stops counting and answers without counts')
}

main().catch(e => { console.error(e); process.exit(1) })
