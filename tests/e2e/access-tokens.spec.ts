import { test, expect, request as pwRequest } from '@playwright/test'
import { authedApi, BASE } from './helpers'

// Personal-access-token (PAT) lifecycle — migration 033 + the /api/v1 surface.
// Proves: create (token shown once) → Bearer auth works on /api/v1/me → the
// session cookie does NOT work on /api/v1 (token-only surface) → auth precedes
// body parsing → revoke kills the token immediately → validation rules
// (scopes algebra, case-insensitive dup names, revoked name freed, expiry).


function bearerCtx(token: string) {
  return pwRequest.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  })
}

async function revokeAll(api: Awaited<ReturnType<typeof authedApi>>) {
  const existing = await (await api.get('/api/settings/access-tokens')).json()
  for (const t of existing) await api.delete(`/api/settings/access-tokens/${t.id}`)
}

test.describe('access tokens (PAT)', () => {
  test('create → bearer works, cookie does not → revoke → 401', async () => {
    const api = await authedApi()
    await revokeAll(api)

    const create = await api.post('/api/settings/access-tokens', {
      data: { name: 'e2e main', scopes: ['read', 'write', 'run'] },
    })
    expect(create.status()).toBe(201)
    const created = await create.json()
    expect(created.token).toMatch(/^cubex_pat_[0-9a-f]{64}$/)
    expect(created.token.startsWith(created.token_prefix)).toBeTruthy()

    // The list never re-exposes the token (hash-only storage).
    const list = await (await api.get('/api/settings/access-tokens')).json()
    expect(list).toHaveLength(1)
    expect(list[0].token).toBeUndefined()

    // Bearer auth works on /api/v1/me and echoes identity + expanded scopes.
    const bearer = await bearerCtx(created.token)
    const me = await bearer.get('/api/v1/me')
    expect(me.status()).toBe(200)
    const body = await me.json()
    expect(typeof body.user_id).toBe('string')
    expect(body.token.name).toBe('e2e main')
    expect(body.token.scopes).toEqual(expect.arrayContaining(['read', 'write', 'run']))

    // The session cookie must NOT authenticate the programmatic surface.
    expect((await api.get('/api/v1/me')).status()).toBe(401)

    // Well-formed-but-unknown and malformed tokens → the same generic 401.
    const unknown = await bearerCtx('cubex_pat_' + '0'.repeat(64))
    expect((await unknown.get('/api/v1/me')).status()).toBe(401)
    const malformed = await bearerCtx('not-a-token')
    expect((await malformed.get('/api/v1/me')).status()).toBe(401)

    // Auth precedes body parsing AND route matching on /api/v1: a POST with a
    // body and a bad token dies 401, never a parse error or 404.
    const sprayed = await malformed.post('/api/v1/me', { data: { junk: 'x'.repeat(1024) } })
    expect(sprayed.status()).toBe(401)

    // Case-insensitive routing can't dodge the parser skip:
    // Express matches /API/V1 to the router, so the skip predicate must too.
    // If the global 32MB parser ran first, this malformed-JSON body would 400
    // before auth; the skip working means auth 401s without any parse.
    const upper = await malformed.post('/API/V1/me', {
      headers: { 'Content-Type': 'application/json' },
      data: 'not-json{{{',
    })
    expect(upper.status()).toBe(401)

    // Revoke → the same bearer context is dead immediately.
    expect((await api.delete(`/api/settings/access-tokens/${created.id}`)).ok()).toBeTruthy()
    expect((await bearer.get('/api/v1/me')).status()).toBe(401)

    await bearer.dispose(); await unknown.dispose(); await malformed.dispose()
  })

  test('validation: scope algebra, duplicate names, expiry', async () => {
    const api = await authedApi()
    await revokeAll(api)

    // 'secrets' without 'run' is the key-exfiltration gate — rejected.
    const noRun = await api.post('/api/settings/access-tokens', {
      data: { name: 'bad scopes', scopes: ['read', 'secrets'] },
    })
    expect(noRun.status()).toBe(400)

    // Unknown scope and empty scopes rejected.
    expect((await api.post('/api/settings/access-tokens', {
      data: { name: 'bad scopes 2', scopes: ['admin'] },
    })).status()).toBe(400)
    expect((await api.post('/api/settings/access-tokens', {
      data: { name: 'bad scopes 3', scopes: [] },
    })).status()).toBe(400)

    // Expiry bounds: 0 rejected; 30 days lands as a real expires_at.
    expect((await api.post('/api/settings/access-tokens', {
      data: { name: 'exp bad', scopes: ['read'], expires_in_days: 0 },
    })).status()).toBe(400)
    const expiring = await api.post('/api/settings/access-tokens', {
      data: { name: 'exp ok', scopes: ['read'], expires_in_days: 30 },
    })
    expect(expiring.status()).toBe(201)
    expect((await expiring.json()).expires_at).toBeTruthy()

    // Case-insensitive duplicate → 409; revoking frees the name.
    const first = await api.post('/api/settings/access-tokens', {
      data: { name: 'Dup Name', scopes: ['read'] },
    })
    expect(first.status()).toBe(201)
    expect((await api.post('/api/settings/access-tokens', {
      data: { name: 'dup name', scopes: ['read'] },
    })).status()).toBe(409)
    await api.delete(`/api/settings/access-tokens/${(await first.json()).id}`)
    const again = await api.post('/api/settings/access-tokens', {
      data: { name: 'dup name', scopes: ['read'] },
    })
    expect(again.status()).toBe(201)

    await revokeAll(api)
  })

  test('token management itself requires the session (a PAT cannot mint PATs)', async () => {
    const anon = await pwRequest.newContext({ baseURL: BASE })
    expect((await anon.get('/api/settings/access-tokens')).status()).toBe(401)
    expect((await anon.post('/api/settings/access-tokens', {
      data: { name: 'x', scopes: ['read'] },
    })).status()).toBe(401)
    await anon.dispose()

    // A valid PAT presented to the settings routes is not a session — 401.
    const api = await authedApi()
    await revokeAll(api)
    const created = await (await api.post('/api/settings/access-tokens', {
      data: { name: 'no escalation', scopes: ['read', 'write', 'run'] },
    })).json()
    const bearer = await bearerCtx(created.token)
    expect((await bearer.get('/api/settings/access-tokens')).status()).toBe(401)
    await bearer.dispose()
    await revokeAll(api)
  })
})
