// What the enrichment and waterfall replay tests share (token-replay-first-{enrich,waterfall}.test.ts): the
// repo's mock treg on a port of its own (stopped when the test ends), an account with a treg key, the job queue
// only recording (nothing is called), and the replay check every case runs. Not a test itself (no .test.ts).
// treg's address is read when the server's modules load: call tregKit before importing them.
import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'

export type Args = Record<string, unknown>
export type Result = { ok: Args; started: boolean } | { fail: string; message: string }
export type Start = (a: Args) => Promise<Result>
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
export const CONFLICT = 'Idempotency key was already used with different arguments.'

export async function tregKit(name: string) {
  if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
  const port = await new Promise<number>(resolve => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port
      s.close(() => resolve(p))
    })
  })
  const treg = spawn(process.execPath, ['tests/mock-treg/server.mjs', String(port)], { stdio: 'ignore' })
  process.on('exit', () => treg.kill())
  const TREG = `http://127.0.0.1:${port}`
  for (;;) {
    try { if ((await fetch(`${TREG}/health`)).ok) break } catch { /* not up yet */ }
    await sleep(50)
  }
  process.env.TREG_BASE_URL = TREG
  // A run webhook's address must look public: the e2e shim resolves *.cubex-e2e.invalid so (nothing is sent).
  process.env.E2E_RECEIVER_PORT = '9'
  createRequire(import.meta.url)('../e2e/net-shim.cjs')

  const { undoKit } = await import('./run-undo-kit')
  const { saveTregToken } = await import('../../server/src/services/treg-key')
  const { createRunWebhook } = await import('../../server/src/services/run-hooks')
  const { writeRunLedger } = await import('../../server/src/lib/run-idempotency')
  const { MCP_RUN_STARTS_PER_MIN } = await import('../../server/src/lib/api-v1-constants')
  const kit = undoKit(name)
  const { db, uid, ok, idle, sheet } = kit
  console.error = () => {}
  saveTregToken(uid, 'treg_mock_unit_team_key')
  const { Sidequest } = createRequire(path.resolve('server/src/queue.ts'))('sidequest')
  Sidequest.build = () => ({ enqueue: async () => ({}) })
  // More retries than the token's run-start window holds: had one taken a slot, the next new start would be refused.
  const TRIES = MCP_RUN_STARTS_PER_MIN + 1
  const runsOn = (sid: string) => db.prepare('SELECT COUNT(*) FROM http_runs WHERE sheet_id = ?').pluck().get(sid)

  // The first call with `key`, then `change`, then: no key refused as `now` says; the key TRIES times, each
  // answering `want` (the first call's answer, replayed) with no run made; the key with `other` arguments refused
  // (`conflict`: the refusal's kind); a new key started.
  async function replays(sid: string, start: Start, args: Args, key: string, o: {
    change: () => Promise<void> | void; now: { fail: string; message: string }; other: Args;
    settle?: () => Promise<void> | void; want?: (first: Args) => Result; conflict?: string;
  }) {
    const first = await start({ ...args, idempotency_key: key })
    assert.ok('ok' in first && first.started, JSON.stringify(first))
    await idle(sid)
    await o.change()
    assert.deepEqual(await start(args), o.now, 'no key: refused now')
    const runs = runsOn(sid)
    // A start's changed (for MCP) is kept with its key: the replay answers it too.
    const changed = 'ok' in first ? first.changed : undefined
    const want = o.want ?? (f => ({ ok: { ...f, replayed: true }, started: false, changed }))
    for (let i = 0; i < TRIES; i++) {
      assert.deepEqual(await start({ ...args, idempotency_key: key }), want(first.ok), `try ${i}`)
    }
    assert.equal(runsOn(sid), runs, 'no second run')
    await o.settle?.()
    assert.deepEqual(await start({ ...o.other, idempotency_key: key }),
      { fail: o.conflict ?? 'conflict', message: CONFLICT })
    const next = await start({ ...o.other, idempotency_key: `${key}-next` })
    assert.ok('ok' in next && next.started, `a new start after the retries: ${JSON.stringify(next)}`)
  }

  // A key from before a start was also known by its arguments as sent: the ledger row of a start made with
  // `key`, written again under `old` with its parsed hash alone (`sent` is the hash of the arguments as sent).
  function preUpgradeRow(key: string, old: string, sent: string | null, kind: 'enrichment_run' | 'waterfall_run') {
    const row = db.prepare(`SELECT request_hash, result_json FROM data_operation_ledger WHERE user_id = ?
      AND idempotency_key = ?`).get(uid, key) as { request_hash: string; result_json: string }
    const parsed = row.request_hash.split(' ').filter(h => h !== sent)
    assert.equal(parsed.length, 1, 'a start is known by two hashes')
    writeRunLedger(uid, old, parsed[0], kind, JSON.parse(row.result_json))
  }

  async function hook(label: string): Promise<string> {
    const made = await createRunWebhook(uid, { url: `https://${label}.cubex-e2e.invalid/done` })
    assert.ok('ok' in made, JSON.stringify(made))
    return made.ok.webhook.id
  }

  return {
    ...kit, ok, TRIES, runsOn, replays, preUpgradeRow, hook,
    caller: (tokenId: string, secrets = false) => ({ userId: uid, tokenId,
      scopes: new Set(['read', 'write', 'run', ...(secrets ? ['secrets'] : [])]) }),
    fresh: () => sheet([{ Name: 'Ada Lovelace', Website: 'a.example' }, { Name: 'Bob Stone', Website: 'b.example' }],
      ['Name', 'Website']),
    tregDown: (down: boolean) => fetch(`${TREG}/__mock/state`, { method: 'POST', body: JSON.stringify({ down }) }),
    stop: () => treg.kill(),
  }
}
