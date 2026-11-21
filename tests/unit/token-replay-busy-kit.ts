// What the busy-sheet replay tests share (token-replay-busy-*.test.ts): /api/v1's run start routes behind the
// busy guard as routes/api-v1.ts mounts it, the MCP server's tools (each behind the MCP guard), and the check each
// start runs. With the sheet held busy, a start sent again with its key replays over the service, REST (the key in
// the body or the Idempotency-Key header) and MCP. A start with a new key or none is refused in the guards' words
// (REST: 409 with busy: true), makes no run, and takes no run-start slot: after more new keys than the token's
// window holds, a new start goes through once the sheet is free. Not a test itself (no .test.ts). Its server
// modules load when busyKit is called, so a kit that sets addresses (token-replay-treg-kit.ts) goes first.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

export type Args = Record<string, unknown>
export type Answer = { ok: Args; started: boolean } | { fail: string; message: string }
// One kind of start: its MCP tool, its path under /api/v1/sheets/:id, its service call by one token, and how many
// runs a sheet has of that kind.
export interface StartKind {
  tool: string; path: string; service: (a: Args) => Promise<Answer>; runsOn: (sid: string) => unknown
}

export async function busyKit(uid: string, routers: express.Router[]) {
  const { refuseChangesWhileBusy, withSheetBusy, busyMessage, sheetBusyWith } =
    await import('../../server/src/lib/sheet-busy')
  const { V1_SHEET_BUSY_ALLOWED } = await import('../../server/src/routes/api-v1-shared')
  const { buildMcpServer } = await import('../../server/src/mcp/build-server')
  const { MCP_RUN_STARTS_PER_MIN } = await import('../../server/src/lib/api-v1-constants')
  const scopes = new Set(['read', 'write', 'run'])
  const app = express()
  app.use(express.json())
  app.use('/v1', (req, _res, next) => {
    Object.assign(req, { userId: uid, accessTokenId: 'tok-busy-v1', tokenScopes: scopes })
    next()
  })
  const gate = express.Router()
  gate.use('/sheets/:id', refuseChangesWhileBusy(V1_SHEET_BUSY_ALLOWED))
  app.use('/v1', gate, ...routers)
  const server = app.listen(0)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  const mcp = buildMcpServer({ userId: uid, tokenId: 'tok-busy-mcp', tokenName: 'n', scopes: scopes as never })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await mcp.connect(serverSide)
  const client = new Client({ name: 'unit', version: '1.0.0' })
  await client.connect(clientSide)

  // A REST start: its status and body. With `header`, the key goes in the Idempotency-Key header.
  async function rest(path: string, a: Args, header?: string) {
    const { sheet_id, ...body } = a
    const res = await fetch(`${base}/sheets/${sheet_id}${path}`, { method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(header ? { 'idempotency-key': header } : {}) } })
    return { status: res.status, body: await res.json() as Args }
  }
  // An MCP start: whether it was refused, and its answer's JSON.
  async function tool(name: string, a: Args) {
    const res = await client.callTool({ name, arguments: a }) as { content: Array<{ text: string }>; isError?: boolean }
    return { isError: res.isError === true, body: JSON.parse(res.content[0].text) as Args }
  }

  // `args` started with `key` by kind.service (`first`, its run_id), the sheet free again; `next`: other arguments
  // for a new start once the check is over.
  async function replaysWhileBusy(kind: StartKind, args: Args & { sheet_id: string }, key: string, first: Args,
    next: Args) {
    const sid = args.sheet_id
    let release = () => {}
    const held = withSheetBusy(sid, 'sorting', () => new Promise<void>(r => { release = r }))
    assert.equal(sheetBusyWith(sid), 'sorting')
    const busy = busyMessage('sorting')
    const runs = kind.runsOn(sid)
    try {
      const keyed = { ...args, idempotency_key: key }
      const service = await kind.service(keyed)
      assert.ok('ok' in service && !service.started, `service: ${JSON.stringify(service)}`)
      const replays: Array<[string, Args]> = [['service', service.ok]]
      const viaBody = await rest(kind.path, keyed), viaHeader = await rest(kind.path, args, key)
      for (const [how, got] of [['rest body', viaBody], ['rest header', viaHeader]] as const) {
        assert.equal(got.status, 200, `${how}: ${JSON.stringify(got.body)}`)
        replays.push([how, got.body])
      }
      const viaMcp = await tool(kind.tool, keyed)
      assert.equal(viaMcp.isError, false, `mcp: ${JSON.stringify(viaMcp.body)}`)
      replays.push(['mcp', viaMcp.body])
      for (const [how, got] of replays) {
        assert.deepEqual([got.run_id, got.replayed], [first.run_id, true], `${how} replays the first start`)
      }
      // A new key or none: the guards' refusal, on every surface.
      const refused = { status: 409, body: { error: busy, busy: true } }
      for (const a of [{ ...args, idempotency_key: `${key}-new` }, args]) {
        assert.deepEqual(await kind.service(a), { fail: 'conflict', message: busy })
        assert.deepEqual(await rest(kind.path, a), refused)
        assert.deepEqual(await tool(kind.tool, a), { isError: true, body: { error: busy } })
      }
      assert.deepEqual(await rest(kind.path, args, `${key}-new-header`), refused)
      for (let i = 0; i <= MCP_RUN_STARTS_PER_MIN; i++) {
        assert.deepEqual(await kind.service({ ...args, idempotency_key: `${key}-try-${i}` }),
          { fail: 'conflict', message: busy }, `new key ${i}`)
      }
      assert.equal(kind.runsOn(sid), runs, 'no run made while busy')
    } finally {
      release()
      await held
    }
    const after = await kind.service({ ...next, idempotency_key: `${key}-after` })
    assert.ok('ok' in after && after.started, `a new start once the sheet is free: ${JSON.stringify(after)}`)
  }

  return { rest, tool, replaysWhileBusy, close: () => { server.close(); void client.close() } }
}
