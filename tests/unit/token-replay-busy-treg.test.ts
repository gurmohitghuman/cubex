// An enrichment start and a waterfall start, each sent again with its idempotency key while its sheet is busy,
// answer their first start over the service, /api/v1 and MCP, past both busy guards; a start with a new key or
// none is refused in the guards' words and takes no run-start slot (token-replay-busy-kit.ts). treg is the repo's
// mock; the job queue only records, so nothing is called.
import assert from 'node:assert/strict'
import { tregKit } from './token-replay-treg-kit'
import { busyKit, type Answer, type Args } from './token-replay-busy-kit'

const k = await tregKit('token-replay-busy-treg')
const { uid, ok, done, idle, runsOn, caller, fresh } = k
const { tokenStartEnrichmentRun } = await import('../../server/src/services/enrich-token-run')
const { tokenWaterfall } = await import('../../server/src/services/waterfall-token-run')
const { default: v1Enrich } = await import('../../server/src/routes/api-v1-enrich')
const { default: v1Waterfall } = await import('../../server/src/routes/api-v1-waterfall')
const kit = await busyKit(uid, [v1Enrich, v1Waterfall])

// Started with `key`, its setup over, then checked with the sheet held busy.
async function check(kind: Parameters<typeof kit.replaysWhileBusy>[0], args: Args & { sheet_id: string },
  key: string, next: Args) {
  const first = await kind.service({ ...args, idempotency_key: key })
  assert.ok('ok' in first && first.started, JSON.stringify(first))
  await idle(args.sheet_id)
  await kit.replaysWhileBusy(kind, args, key, first.ok, next)
}

await ok('an enrichment retried with its key while the sheet is busy replays; a new key or none is refused',
  async () => {
    const c = caller('tok-busy-enrich')
    const kind = {
      tool: 'run_enrichment', path: '/enrichment-runs', runsOn,
      service: (a: Args) => tokenStartEnrichmentRun(c, a as Parameters<typeof tokenStartEnrichmentRun>[1]) as
        Promise<Answer>,
    }
    const args = { sheet_id: fresh(), tool_id: 'treg.people.email.find', preset: 'verified_email',
      column_name: 'Work email', inputs: { full_name: 'Name', domain: 'Website' } }
    await check(kind, args, 'busy-enrich',
      { ...args, column_name: 'Other email', outputs: [{ field: 'email', column_name: 'Other' }] })
  })

await ok('a waterfall retried with its key while the sheet is busy replays; a new key or none is refused',
  async () => {
    const c = caller('tok-busy-waterfall')
    const kind = {
      tool: 'waterfall_column', path: '/waterfall-columns', runsOn,
      service: (a: Args) => tokenWaterfall(c, a, { estimateDefault: true }) as Promise<Answer>,
    }
    const steps = [
      { kind: 'http', label: 'Own API', url: 'https://api.example.com/find?d={{domain}}', value_path: '$.email' },
    ]
    const args = { sheet_id: fresh(), column_name: 'Found', result_type: 'email', inputs: { domain: 'Website' },
      steps, estimate_only: false }
    await check(kind, args, 'busy-waterfall', { ...args, column_name: 'Found 2' })
  })

kit.close()
done()
