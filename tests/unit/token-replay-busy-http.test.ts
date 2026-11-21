// An HTTP API run start sent again with its idempotency key while its sheet is busy answers its first start, over
// the service, /api/v1 and MCP, past both busy guards; a start with a new key or none is refused in the guards'
// words and takes no run-start slot (token-replay-busy-kit.ts). transfer_rows stays behind both guards with a key:
// a keyed transfer from a busy sheet is refused as busy, over MCP and REST. Nothing is sent: the job queue only
// records.
import assert from 'node:assert/strict'
import { httpKit } from './token-replay-http-kit'
import { busyKit, type Answer, type Args } from './token-replay-busy-kit'

const k = await httpKit('token-replay-busy-http')
const { uid, ok, done, idle, fresh, runsOn } = k
const { tokenStartHttpRun } = await import('../../server/src/services/run-start-token-http')
const { withSheetBusy, busyMessage } = await import('../../server/src/lib/sheet-busy')
const { default: v1Runs } = await import('../../server/src/routes/api-v1-runs')
const kit = await busyKit(uid, [v1Runs])
const c = { userId: uid, tokenId: 'tok-busy-http', scopes: new Set(['read', 'write', 'run']) }
const kind = {
  tool: 'run_http_enrichment', path: '/http-runs', runsOn,
  service: (a: Args) => tokenStartHttpRun(c, a as Parameters<typeof tokenStartHttpRun>[1]) as Promise<Answer>,
}
const mapping = (column: string) => [{ json_path: '$.ok', column_name: column }]

await ok('an HTTP API start retried with its key while the sheet is busy replays; a new key or none is refused',
  async () => {
    const sid = fresh()
    const args = { sheet_id: sid, url: 'https://api.example.com/ask?n={{Name}}', master_column_name: 'Ask',
      response_mapping: mapping('Said') }
    const first = await kind.service({ ...args, idempotency_key: 'busy-http' })
    assert.ok('ok' in first && first.started, JSON.stringify(first))
    await idle(sid)
    await kit.replaysWhileBusy(kind, args, 'busy-http', first.ok,
      { ...args, master_column_name: 'Ask 2', response_mapping: mapping('Said 2') })
  })

await ok('a keyed transfer_rows from a busy sheet is refused as busy, over MCP and REST', async () => {
  const sid = fresh(), dest = fresh()
  const args = { source_sheet_id: sid, destination_sheet_id: dest, operation: 'copy', selection: { all: true },
    idempotency_key: 'busy-transfer' }
  await withSheetBusy(sid, 'sorting', async () => {
    const busy = busyMessage('sorting')
    assert.deepEqual(await kit.tool('transfer_rows', args), { isError: true, body: { error: busy } })
    const { source_sheet_id: _s, ...body } = args
    assert.deepEqual(await kit.rest('/rows/transfer', { sheet_id: sid, ...body }),
      { status: 409, body: { error: busy, busy: true } })
  })
})

kit.close()
k.close()
done()
