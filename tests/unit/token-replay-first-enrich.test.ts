// An enrichment or waterfall start (and a waterfall dry run) sent again with its idempotency key answers what its
// first call started (replayed: true), whatever changed since: the key is read before the catalog, the webhook,
// the sheet and its rows. An enrichment whose webhook was deleted while treg's catalog can't be reached, a
// waterfall whose webhook was deleted, and a dry run whose row was deleted: the same call with no key is refused
// now; with its key, sent more times than the token's run-start window holds, it answers the first call each
// time, makes no run and takes no slot (a new start goes through after). The same key with other arguments is
// still refused. treg is the repo's mock (tests/mock-treg); the job queue only records, so nothing is called.
import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// The mock treg, on a port of its own; stopped when this test ends.
const tregPort = await new Promise<number>(resolve => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as AddressInfo).port
    s.close(() => resolve(p))
  })
})
const treg = spawn(process.execPath, ['tests/mock-treg/server.mjs', String(tregPort)], { stdio: 'ignore' })
process.on('exit', () => treg.kill())
const TREG = `http://127.0.0.1:${tregPort}`
for (;;) {
  try { if ((await fetch(`${TREG}/health`)).ok) break } catch { /* not up yet */ }
  await sleep(50)
}
process.env.TREG_BASE_URL = TREG
const tregDown = (down: boolean) => fetch(`${TREG}/__mock/state`, { method: 'POST', body: JSON.stringify({ down }) })
// A run webhook's address must look public: the e2e shim resolves *.cubex-e2e.invalid so (nothing is sent).
process.env.E2E_RECEIVER_PORT = '9'
createRequire(import.meta.url)('../e2e/net-shim.cjs')

const { undoKit } = await import('./run-undo-kit')
const { saveTregToken } = await import('../../server/src/services/treg-key')
const { clearCatalogCache } = await import('../../server/src/lib/treg-catalog')
const { createRunWebhook, deleteRunWebhook } = await import('../../server/src/services/run-hooks')
const { deleteRowsByIds } = await import('../../server/src/services/rows-write')
const { tokenStartEnrichmentRun } = await import('../../server/src/services/enrich-token-run')
const { tokenWaterfall } = await import('../../server/src/services/waterfall-token-run')
const { MCP_RUN_STARTS_PER_MIN } = await import('../../server/src/lib/api-v1-constants')
const { db, uid, ok, done, idle, sheet } = undoKit('token-replay-first-enrich')
console.error = () => {}
saveTregToken(uid, 'treg_mock_unit_team_key')
createRequire(path.resolve('server/src/queue.ts'))('sidequest').Sidequest.build = () => ({ enqueue: async () => ({}) })

type Args = Record<string, unknown>
type Start = (a: Args) => ReturnType<typeof tokenWaterfall>
const c = (tokenId: string) => ({ userId: uid, tokenId, scopes: new Set(['read', 'write', 'run']) })
const fresh = () => sheet([{ Name: 'Ada Lovelace', Website: 'a.example' }, { Name: 'Bob Stone', Website: 'b.example' }],
  ['Name', 'Website'])
const runsOn = (sid: string) => db.prepare('SELECT COUNT(*) FROM http_runs WHERE sheet_id = ?').pluck().get(sid)
const CONFLICT = 'Idempotency key was already used with different arguments.'
const HOOK_GONE = "webhook_id doesn't match a run webhook. "
  + 'List them with list_run_webhooks or GET /api/v1/run-webhooks.'
const TRIES = MCP_RUN_STARTS_PER_MIN + 1
async function hook(name: string): Promise<string> {
  const made = await createRunWebhook(uid, { url: `https://${name}.cubex-e2e.invalid/done` })
  assert.ok('ok' in made, JSON.stringify(made))
  return made.ok.webhook.id
}

// The first call with `key`, then `change`, then: no key refused as `now` says; the key TRIES times, each the
// first call's answer replayed with no run made; the key with `other` arguments refused; a new key started.
// dry: a dry run's answer is its trace, read again (its run is compared), and a key it knows with other arguments
// is refused as a bad request (400), as before.
async function replays(sid: string, start: Start, args: Args, key: string, change: () => Promise<void> | void,
  now: { fail: string; message: string }, other: Args, settle?: () => Promise<void> | void, dry = false) {
  const seen = (o: Args) => (dry ? { dry_run: o.dry_run, run_id: o.run_id, replayed: o.replayed } : o)
  const first = await start({ ...args, idempotency_key: key })
  assert.ok('ok' in first && first.started, JSON.stringify(first))
  await idle(sid)
  await change()
  assert.deepEqual(await start(args), now, 'no key: refused now')
  const runs = runsOn(sid)
  for (let i = 0; i < TRIES; i++) {
    const again = await start({ ...args, idempotency_key: key })
    assert.ok('ok' in again, JSON.stringify(again))
    assert.deepEqual({ ok: seen(again.ok as Args), started: again.started },
      { ok: seen({ ...first.ok, replayed: true }), started: false }, `try ${i}`)
  }
  assert.equal(runsOn(sid), runs, 'no second run')
  await settle?.()
  assert.deepEqual(await start({ ...other, idempotency_key: key }),
    { fail: dry ? 'bad_request' : 'conflict', message: CONFLICT })
  const next = await start({ ...other, idempotency_key: `${key}-next` })
  assert.ok('ok' in next && next.started, `a new start after the retries: ${JSON.stringify(next)}`)
}

await ok(`an enrichment retried with its key after its webhook was deleted and while treg's catalog can't be `
  + `reached answers the first start ${TRIES} times`, async () => {
  const sid = fresh()
  const args = { sheet_id: sid, tool_id: 'treg.people.email.find', preset: 'verified_email', column_name: 'Work email',
    inputs: { full_name: 'Name', domain: 'Website' }, webhook_id: await hook('enrich') }
  const start: Start = a => tokenStartEnrichmentRun(c('tok-enrich'), a)
  await replays(sid, start, args, 'enrich-K', async () => {
    assert.equal(deleteRunWebhook(uid, args.webhook_id), true)
    await tregDown(true)
    clearCatalogCache()
  }, { fail: 'upstream', message: "Can't reach treg's catalog right now. Try again in a moment." },
  { ...args, webhook_id: undefined, column_name: 'Other email', outputs: [{ field: 'email', column_name: 'Other' }] },
  async () => { await tregDown(false) })
})

const STEPS = [
  { kind: 'http', label: 'Own API', url: 'https://api.example.com/find?d={{domain}}', value_path: '$.email' },
]
const waterfall = (sid: string, more: Args = {}) => ({ sheet_id: sid, column_name: 'Found', result_type: 'email',
  inputs: { domain: 'Website' }, steps: STEPS, ...more })

await ok(`a waterfall retried with its key after its webhook was deleted answers the first start ${TRIES} times`,
  async () => {
    const sid = fresh()
    const args = waterfall(sid, { webhook_id: await hook('waterfall'), estimate_only: false })
    const start: Start = a => tokenWaterfall(c('tok-waterfall'), a, { estimateDefault: true })
    await replays(sid, start, args, 'waterfall-K', () => {
      assert.equal(deleteRunWebhook(uid, args.webhook_id as string), true)
    }, { fail: 'bad_request', message: HOOK_GONE }, { ...args, webhook_id: undefined, column_name: 'Other' })
  })

await ok(`a waterfall dry run retried with its key after its row was deleted reads the first dry run ${TRIES} times`,
  async () => {
    const sid = fresh()
    const [rowId] = db.prepare('SELECT id FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sid) as string[]
    const args = waterfall(sid, { dry_run: true, target_row_ids: [rowId] })
    // The queue only records: a dry run is marked done here once it is made, so its answer doesn't wait.
    const start: Start = async a => {
      const before = runsOn(sid)
      let answered = false
      const answer = tokenWaterfall(c('tok-dry'), a, { estimateDefault: true }).finally(() => { answered = true })
      while (!answered && runsOn(sid) === before) await sleep(10)
      db.prepare("UPDATE http_runs SET status = 'completed' WHERE sheet_id = ? AND status != 'completed'").run(sid)
      return answer
    }
    await replays(sid, start, args, 'dry-K', () => {
      const out = deleteRowsByIds(sid, uid, [rowId])
      assert.ok(!('fail' in out), JSON.stringify(out))
    }, { fail: 'bad_request', message: `Unknown row id(s): ${rowId}` },
    waterfall(sid, { dry_run: true, column_name: 'Other' }), undefined, true)
  })

treg.kill()
done()
