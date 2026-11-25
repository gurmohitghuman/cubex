// A run an agent starts over MCP is its token's (#47's audit, H5): through the real router (routes/mcp.ts), signed
// in with a real token, a run_http_enrichment call on either protocol era (2026-07-28, and a 2025-era request with
// no envelope) starts a run whose access_token_id is that token, so what the run spends counts against the token's
// cap (run_usage → token_spend, migration 042) and nobody else's. The token comes to the run through the request's
// actor (lib/actor.ts), not an argument, so an era whose handling lost it would start the run as Cubex's own.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { v4 as uuid } from 'uuid'
import { mcpHttpKit, META, headersFor } from './mcp-http-kit'
import dbMod from '../../server/src/lib/db'
import tokenMod from '../../server/src/lib/access-token'
import routeMod from '../../server/src/routes/mcp'
import spendMod from '../../server/src/services/token-spend'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { sha256Hex } = tokenMod as typeof import('../../server/src/lib/access-token')
const router = (routeMod as unknown as { default: express.Router }).default
const { readTokenSpend } = spendMod as typeof import('../../server/src/services/token-spend')

const { ctx, check, done, crash } = mcpHttpKit('mcp-run-token-spend')
// The job queue isn't running here: a run's queuing fails in the background, after its row is written. Only that
// line is left out of the log.
const logError = console.error
console.error = (...args: unknown[]) => { if (!/^Queueing \w+ run .* failed/.test(String(args[0]))) logError(...args) }
const tokens = ['8', '9'].map(d => {
  const secret = `cubex_pat_${d.repeat(64)}`, id = uuid()
  db.prepare(`INSERT INTO access_tokens (id, user_id, name, token_hash, token_prefix, scopes, spend_cap_micro)
    VALUES (?,?,?,?,?,?,?)`).run(id, ctx.userId, `agent ${d}`, sha256Hex(secret), `cubex_pat_${d}`, 'read,write,run',
    5_000_000)
  return { id, secret }
})
const tableId = uuid(), sheetId = uuid()
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, ctx.userId, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
  .run(sheetId, tableId, ctx.userId, 'S', JSON.stringify(['Name']))
db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
  .run(uuid(), sheetId, ctx.userId, 0, JSON.stringify({ Name: 'Ada' }))

const spent = (tokenId: string) => readTokenSpend(ctx.userId, tokenId)!.spentUsd

async function main() {
  const app = express()
  app.use('/mcp', router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
  let lastId = 0
  // run_http_enrichment as `secret`'s agent, on one era or the other: the run it started.
  const startRun = async (secret: string, era: 'modern' | 'legacy', column: string): Promise<string> => {
    const name = 'run_http_enrichment'
    const args = { sheet_id: sheetId, url: 'https://api.example.com/find?n={{Name}}', master_column_name: column,
      response_mapping: [{ json_path: '$.email', column_name: `${column} email` }] }
    const params = era === 'modern' ? { name, arguments: args, _meta: META } : { name, arguments: args }
    const res = await fetch(url, { method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: ++lastId, method: 'tools/call', params }),
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', ...(era === 'modern' ? headersFor('tools/call', name) : {}) } })
    const text = await res.text()
    assert.equal(res.status, 200, text)
    // A 2025-era answer may come as one server-sent event.
    const body = JSON.parse(text.startsWith('event:') || text.startsWith('data:')
      ? text.split('\n').find(l => l.startsWith('data:'))!.slice(5) : text)
    assert.ok(!body.result.isError, JSON.stringify(body.result))
    return body.result.structuredContent.run_id as string
  }
  // What the runner writes as a run's rows are paid for.
  const pay = (runId: string, micro: number) =>
    db.prepare('UPDATE http_runs SET spent_micro = spent_micro + ? WHERE id = ?').run(micro, runId)

  try {
    for (const era of ['modern', 'legacy'] as const) {
      await check(`${era}: the run is the calling token's, and what it spends counts against that token only`,
        async () => {
          const [mine, other] = tokens
          const runId = await startRun(mine.secret, era, `Call ${era}`)
          const run = db.prepare('SELECT access_token_id FROM http_runs WHERE id = ?').get(runId) as
            { access_token_id: string | null }
          assert.equal(run.access_token_id, mine.id)
          const before = [spent(mine.id), spent(other.id)]
          pay(runId, 25_000)
          assert.deepEqual([spent(mine.id), spent(other.id)], [before[0] + 0.025, before[1]])
        })
    }
  } finally {
    server.close()
  }
  done()
}
main().catch(crash)
