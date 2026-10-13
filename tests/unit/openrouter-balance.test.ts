// What OpenRouter reports for the saved key (services/openrouter-balance.ts),
// against a stubbed OpenRouter (global fetch): the account balance only when
// /credits answers (it needs a management key), the key's own limit from /key,
// available = the smaller known one, nothing invented, and a short cache.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let credits: { status: number; body?: unknown } = { status: 403 }
let key: { status: number; body?: unknown } = { status: 200, body: { data: {} } }
let reads = 0
const answer = (r: { status: number; body?: unknown }) => new Response(JSON.stringify(r.body ?? {}), {
  status: r.status, headers: { 'content-type': 'application/json' },
})
globalThis.fetch = (async (input: string | URL) => {
  const url = String(input)
  reads++
  if (url.endsWith('/credits')) return answer(credits)
  if (url.endsWith('/auth/key')) return answer(key)
  return new Response('{}', { status: 404 })
}) as typeof fetch

async function main() {
  const { db } = await import('../../server/src/lib/db')
  const { runMigrations } = await import('../../server/src/db/migrate')
  const { encrypt } = await import('../../server/src/lib/crypto')
  const { readOpenRouterBalance } = await import('../../server/src/services/openrouter-balance')
  runMigrations()
  const uid = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  const read = async () => readOpenRouterBalance(uid)

  const none = await read()
  assert.ok('fail' in none && none.fail === 'no_key', 'no key saved')
  const setKey = (k: string) => db.prepare(`INSERT INTO settings (id, user_id, openrouter_api_key_encrypted)
    VALUES (?,?,?) ON CONFLICT(user_id)
    DO UPDATE SET openrouter_api_key_encrypted = excluded.openrouter_api_key_encrypted`).run(uuid(), uid, encrypt(k))

  // An ordinary key: /credits refused, no limit on the key. Nothing to compare against.
  setKey('sk-or-one')
  key = {
    status: 200,
    body: { data: { usage: 3.5, limit: null, limit_remaining: null, byok_usage: 1.25, is_free_tier: false } },
  }
  const plain = await read()
  assert.ok('ok' in plain)
  assert.deepEqual(plain.ok, {
    balance_usd: null, key_limit_usd: null, key_limit_remaining_usd: null, key_usage_usd: 3.5,
    byok_usage_usd: 1.25, is_free_tier: false, available_usd: null,
  })

  // Read again within the cache window: no new calls.
  const before = reads
  await read()
  assert.equal(reads, before, 'cached')

  // A new key is read fresh: a key limit, and the account balance /credits shared.
  setKey('sk-or-two')
  credits = { status: 200, body: { data: { total_credits: 20, total_usage: 12 } } }
  key = { status: 200, body: { data: { usage: 6, limit: 10, limit_remaining: 4 } } }
  const both = await read()
  assert.ok('ok' in both)
  assert.equal(both.ok.balance_usd, 8)
  assert.equal(both.ok.key_limit_remaining_usd, 4)
  assert.equal(both.ok.available_usd, 4, 'the smaller of the two')
  assert.equal(both.ok.is_free_tier, null, 'not said: null, not false')

  // A rejected key says so.
  setKey('sk-or-three')
  key = { status: 401 }
  const bad = await read()
  assert.ok('fail' in bad && bad.fail === 'rejected')
  console.log('openrouter-balance: ok')
}
main().catch(e => { console.error(e); process.exit(1) })
