import { test, expect, request as pwRequest } from '@playwright/test'
import { BASE, TEST_PASSWORD } from './helpers'

// The single-account login rules (server/src/routes/auth.ts). The harness has
// already run first-time setup with TEST_PASSWORD, so this covers everything
// after it: setup is closed for good, wrong passwords are rejected, and a
// password change signs out every other session. Each test leaves the password
// at TEST_PASSWORD, because every other spec logs in with it.
const api = () => pwRequest.newContext({ baseURL: BASE })

async function signedIn() {
  const ctx = await api()
  const res = await ctx.post('/api/auth/login', { data: { password: TEST_PASSWORD } })
  expect(res.status()).toBe(200)
  return ctx
}

test('status reports setup done; a second setup is refused', async () => {
  const anon = await api()
  expect(await (await anon.get('/api/auth/status')).json())
    .toEqual({ setupRequired: false, authenticated: false })
  // Nobody can claim the instance again, whatever password they pick.
  const setup = await anon.post('/api/auth/setup', { data: { password: 'a-brand-new-password' } })
  expect(setup.status()).toBe(409)
  await anon.dispose()

  const ctx = await signedIn()
  expect((await (await ctx.get('/api/auth/status')).json()).authenticated).toBe(true)
  await ctx.dispose()
})

test('wrong password is a 401; protected routes need a session', async () => {
  const anon = await api()
  expect((await anon.post('/api/auth/login', { data: { password: 'not-the-password' } })).status()).toBe(401)
  expect((await anon.post('/api/auth/login', { data: {} })).status()).toBe(401)
  expect((await anon.get('/api/tables')).status()).toBe(401)
  await anon.dispose()
})

test('change password: wrong current is a 400, success signs out other sessions', async () => {
  const other = await signedIn()
  const ctx = await signedIn()
  const NEW_PASSWORD = 'temporary-e2e-password'

  // 400, not 401: the client treats any 401 as "signed out".
  const wrong = await ctx.post('/api/auth/change-password', {
    data: { currentPassword: 'not-the-password', newPassword: NEW_PASSWORD },
  })
  expect(wrong.status()).toBe(400)
  const short = await ctx.post('/api/auth/change-password', {
    data: { currentPassword: TEST_PASSWORD, newPassword: 'short' },
  })
  expect(short.status()).toBe(400)

  try {
    const changed = await ctx.post('/api/auth/change-password', {
      data: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
    })
    expect(changed.status()).toBe(200)
    // This browser got a fresh cookie; the other one is signed out.
    expect((await ctx.get('/api/tables')).status()).toBe(200)
    expect((await other.get('/api/tables')).status()).toBe(401)

    const anon = await api()
    expect((await anon.post('/api/auth/login', { data: { password: TEST_PASSWORD } })).status()).toBe(401)
    expect((await anon.post('/api/auth/login', { data: { password: NEW_PASSWORD } })).status()).toBe(200)
    await anon.dispose()
  } finally {
    // Restore the shared test password for every later spec.
    const restore = await ctx.post('/api/auth/change-password', {
      data: { currentPassword: NEW_PASSWORD, newPassword: TEST_PASSWORD },
    })
    expect(restore.status()).toBe(200)
  }
  await ctx.dispose()
  await other.dispose()
})
