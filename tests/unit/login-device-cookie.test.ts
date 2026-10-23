// Sign-in budgets with device cookies, through the real auth router on a
// throwaway DB (LOGIN_RATE_MAX 3). Pins: wrong guesses from a browser that never
// signed in spend the shared budget and then lock out only such browsers; a
// browser that has signed in (setup, login, or a session from before device
// cookies, on its next /status) keeps a budget of its own, even signed out, and
// spends only that one; a forged or altered cookie counts as new, and one
// planted beside the real one doesn't hide it; the cookie is Secure behind
// HTTPS; changing the password ends every device cookie but the changing
// browser's new one.
import express from 'express'
import cookieParser from 'cookie-parser'
import type { AddressInfo } from 'node:net'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
process.env.LOGIN_RATE_MAX = '3'

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const PW = 'the-owners-password', NEW_PW = 'a-new-owner-password'

// A browser: its cookies, kept from each answer's Set-Cookie (`planted` goes
// first in the header, as a cookie with a longer path would).
class Browser {
  jar = new Map<string, string>()
  attrs = new Map<string, string>()
  planted = ''
  setCookies: string[] = []
  constructor(private base: string, private headers: Record<string, string> = {}) {}
  async send(method: string, path: string, body?: unknown): Promise<number> {
    const cookie = [this.planted, ...[...this.jar].map(([k, v]) => `${k}=${v}`)].filter(Boolean).join('; ')
    const res = await fetch(this.base + path, {
      method, headers: { 'content-type': 'application/json', ...this.headers, ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    this.setCookies = res.headers.getSetCookie()
    for (const line of this.setCookies) {
      const [pair] = line.split(';')
      const at = pair.indexOf('=')
      const name = pair.slice(0, at), value = pair.slice(at + 1)
      if (value) { this.jar.set(name, value); this.attrs.set(name, line) } else this.jar.delete(name)
    }
    await res.text()
    return res.status
  }
  login(password: string) { return this.send('POST', '/api/auth/login', { password }) }
}

async function main() {
  const { db } = await import('../../server/src/lib/db')
  const { runMigrations } = await import('../../server/src/db/migrate')
  const { signToken } = await import('../../server/src/lib/auth')
  const authRoutes = (await import('../../server/src/routes/auth')).default
  runMigrations()
  const app = express()
  app.use(cookieParser())
  app.use('/api/auth', authRoutes)
  const server = app.listen(0)
  await new Promise(r => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const owner = new Browser(base)
  check('setup signs the browser in', await owner.send('POST', '/api/auth/setup', { password: PW }) === 200)
  const attrs = owner.attrs.get('cubex_device') ?? ''
  check('... and gives it a device cookie only /api/auth sees, HttpOnly and SameSite=Strict',
    /Path=\/api\/auth/.test(attrs) && /HttpOnly/i.test(attrs) && /SameSite=Strict/i.test(attrs), attrs)
  const other = new Browser(base)
  check('another browser signs in', await other.login(PW) === 200 && other.jar.has('cubex_device'))
  check('... and its next page load sets no cookie', await other.send('GET', '/api/auth/status') === 200
    && other.setCookies.length === 0, other.setCookies)
  const behindProxy = new Browser(base, { 'x-forwarded-proto': 'https' })
  check('behind HTTPS the device cookie is Secure', await behindProxy.login(PW) === 200
    && /;\s*Secure/i.test(behindProxy.attrs.get('cubex_device') ?? ''), behindProxy.attrs.get('cubex_device'))

  const stranger = new Browser(base)
  const tries = [await stranger.login('guess-1'), await stranger.login('guess-2'), await stranger.login('guess-3')]
  check('wrong guesses from a new browser are refused', tries.every(s => s === 401), tries)
  check('... until the shared budget is spent', await stranger.login('guess-4') === 429)
  check('... then even the right password from a new browser waits', await new Browser(base).login(PW) === 429)

  check('the owner signs out', await owner.send('POST', '/api/auth/logout') === 200 && !owner.jar.has('cubex_session'))
  check('... and signs in again on their own budget', await owner.login(PW) === 200)

  const [id, mac] = owner.jar.get('cubex_device')!.split('.')
  const fakes = [['a forged cookie', `${id}.${'A'.repeat(43)}`], ['an altered id', `${'B'.repeat(22)}.${mac}`],
    ['junk', 'x']] as const
  for (const [what, value] of fakes) {
    const b = new Browser(base)
    b.jar.set('cubex_device', value)
    check(`${what} counts as a new browser`, await b.login(PW) === 429)
  }
  owner.planted = 'cubex_device=planted.by-someone-else'
  check("a cookie planted ahead of the real one doesn't hide it", await owner.login(PW) === 200)
  owner.planted = ''

  // A browser signed in before device cookies existed: a session, no device cookie.
  const user = db.prepare('SELECT id, session_epoch FROM users').get() as { id: string; session_epoch: number }
  const older = new Browser(base)
  older.jar.set('cubex_session', signToken({ userId: user.id, sessionEpoch: user.session_epoch }))
  check('a signed-in browser without one gets a device cookie on /status',
    await older.send('GET', '/api/auth/status') === 200 && older.jar.has('cubex_device'))
  older.jar.delete('cubex_session')
  check('... which signs it in on its own budget', await older.login(PW) === 200)
  const deviceBefore = owner.jar.get('cubex_device')
  check('a later sign-in keeps the device id', await owner.login(PW) === 200
    && owner.jar.get('cubex_device')!.split('.')[0] === deviceBefore!.split('.')[0])

  const own = [await owner.login('typo-1'), await owner.login('typo-2'), await owner.login('typo-3')]
  check("a browser's own wrong guesses are refused", own.every(s => s === 401), own)
  check('... and lock out only that browser', await owner.login(PW) === 429 && await older.login(PW) === 200)

  check('changing the password works from a signed-in browser', await older.send('POST', '/api/auth/change-password',
    { currentPassword: PW, newPassword: NEW_PW }) === 200)
  check('... its new device cookie still has a budget of its own', await older.login(NEW_PW) === 200)
  check("... every other browser's device cookie is over", await other.login(NEW_PW) === 429)

  server.close()
  console.log(failures === 0 ? '\nlogin device cookies: all passed' : `\nlogin device cookies: ${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
