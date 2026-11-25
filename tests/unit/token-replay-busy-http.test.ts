// An HTTP API run start sent again with its idempotency key while its sheet is busy answers its first start, over
// the service, /api/v1 and MCP, past both busy guards; a start with a new key or none is refused in the guards'
// words and takes no run-start slot (token-replay-busy-kit.ts). A keyed transfer_rows the same:
// transfer-replay-busy.test.ts. Nothing is sent: the job queue only records.
import assert from 'node:assert/strict'
import { httpKit } from './token-replay-http-kit'
import { busyKit, type Answer, type Args } from './token-replay-busy-kit'

const k = await httpKit('token-replay-busy-http')
const { uid, ok, done, idle, fresh, runsOn } = k
const { tokenStartHttpRun } = await import('../../server/src/services/run-start-token-http')
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

kit.close()
k.close()
done()
