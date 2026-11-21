// An AI run start sent again with its idempotency key while its sheet is busy (a sort here; on a big sheet, that
// very start still setting up its rows) answers its first start, over the service, /api/v1 and MCP, past both
// busy guards. A start with a new key or none is refused in the guards' words and takes no run-start slot
// (token-replay-busy-kit.ts). The stand-in for OpenRouter is ai-spend-kit.ts's; the job queue only records.
import assert from 'node:assert/strict'
import { startStandIn, world, PRICED } from './ai-spend-kit'
import { busyKit, type Answer, type Args } from './token-replay-busy-kit'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const stand = await startStandIn()
const { db, uid, ok, sheetOf, done } = await world()
const { tokenStartAiRun } = await import('../../server/src/services/run-start-token')
const { sheetBusyWith } = await import('../../server/src/lib/sheet-busy')
const { default: v1Runs } = await import('../../server/src/routes/api-v1-runs')
const idle = async (sid: string) => { while (sheetBusyWith(sid)) await new Promise(r => setTimeout(r, 5)) }
const kit = await busyKit(uid, [v1Runs])
const c = { userId: uid, tokenId: 'tok-busy-ai', scopes: new Set(['read', 'write', 'run']) }
const kind = {
  tool: 'run_ai_column', path: '/ai-runs',
  service: (a: Args) => tokenStartAiRun(c, a as Parameters<typeof tokenStartAiRun>[1]) as Promise<Answer>,
  runsOn: (sid: string) => db.prepare('SELECT COUNT(*) FROM ai_runs WHERE sheet_id = ?').pluck().get(sid),
}

await ok('an AI start retried with its key while the sheet is busy replays; a new key or none is refused as busy',
  async () => {
    const sid = sheetOf(2)
    const args = { sheet_id: sid, column_name: 'Hi', prompt: 'Say hi to /name', model: PRICED }
    const first = await kind.service({ ...args, idempotency_key: 'busy-ai' })
    assert.ok('ok' in first && first.started, JSON.stringify(first))
    await idle(sid)
    await kit.replaysWhileBusy(kind, args, 'busy-ai', first.ok, { ...args, column_name: 'Other' })
  })

kit.close()
stand.close()
done()
process.exit(0)
