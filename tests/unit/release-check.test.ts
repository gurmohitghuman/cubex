// The release check (services/release-check.ts) against a stand-in GitHub on 127.0.0.1, never the real
// one: a newer, the same and an older release; offline, rate limited and answers that aren't a release
// (each keeps the last good answer); the check turned off (the answer deleted, nothing asked, a late
// answer not kept); at most one automatic check a day; and the running version read from the
// installer's file (a release, a branch, a local source, none).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

interface Reply { status: number; body: string; headers?: Record<string, string> }
const seen: http.IncomingMessage[] = []
let reply: Reply = { status: 404, body: '{}' }
let hold: Promise<void> | null = null
const github = http.createServer((req, res) => {
  seen.push(req)
  void Promise.resolve(hold).then(() => {
    res.writeHead(reply.status, { 'Content-Type': 'application/json', ...(reply.headers ?? {}) })
    res.end(reply.body)
  })
})
await new Promise<void>(r => github.listen(0, '127.0.0.1', () => r()))
const port = (github.address() as { port: number }).port
// A folder laid out like an install: app/.cubex-version, install.env and the installer's marker.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cubex-home-'))
fs.mkdirSync(path.join(home, 'app'))
const versionFile = path.join(home, 'app', '.cubex-version')
const installEnv = path.join(home, 'install.env')
const marker = path.join(home, '.cubex-home')
// Read when the modules load: the stand-in's address and the install folder.
process.env.RELEASE_CHECK_URL = `http://127.0.0.1:${port}/repos/gurmohitghuman/cubex/releases/latest`
process.env.CUBEX_TEST_HOME = home

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const { compareVersions, parseTag, pinnedFrom, runningFrom, runningVersion } =
  await import('../../server/src/lib/cubex-version')
const store = await import('../../server/src/lib/release-store')
const check = await import('../../server/src/services/release-check')
const { versionInfo } = await import('../../server/src/services/version-info')
runMigrations()

const USER = 'user-1'
db.prepare("INSERT INTO users (id, password_hash) VALUES (?, 'x')").run(USER)
const release = (tag: string, extra: Record<string, unknown> = {}): Reply =>
  ({ status: 200, body: JSON.stringify({ tag_name: tag, published_at: '2026-11-12T15:04:05Z', ...extra }) })
const running = (line: string | null) => {
  if (line === null) fs.rmSync(versionFile, { force: true })
  else fs.writeFileSync(versionFile, line)
}

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn()
  console.log(`  ok - ${name}`)
}

await test('versions compare as numbers, part by part', () => {
  const v = (s: string) => parseTag(s)!
  assert.ok(compareVersions(v('v0.8.10'), v('v0.8.9')) > 0)
  assert.ok(compareVersions(v('v1.0.0'), v('v0.99.99')) > 0)
  assert.equal(compareVersions(v('0.8.9'), v('v0.8.9')), 0)
  for (const bad of ['main', 'v0.8', 'v0.8.9-rc.1', 'v0.8.9.1', '', 'vx.y.z']) assert.equal(parseTag(bad), null, bad)
})

await test("the running version is the installer file's first word, when it is a release", () => {
  assert.deepEqual(runningFrom('v0.8.12 6071123\n'), { build: 'v0.8.12 6071123', version: 'v0.8.12' })
  assert.deepEqual(runningFrom('v0.8.12 6071123\r\n'), { build: 'v0.8.12 6071123', version: 'v0.8.12' })
  assert.deepEqual(runningFrom('v0.8.12 \n'), { build: 'v0.8.12', version: 'v0.8.12' })
  assert.deepEqual(runningFrom('main 6071123'), { build: 'main 6071123', version: null })
  const local = 'local 6071123 2026-11-13 10:00'
  assert.deepEqual(runningFrom(local), { build: local, version: null })
  assert.deepEqual(runningFrom(null), { build: null, version: null })
  assert.deepEqual(runningFrom('  \n'), { build: null, version: null })
  assert.equal(runningFrom(`v1.2.3 ${'a'.repeat(500)}\u0007`).build!.length, 120)
})

await test("a pin is install.env's CUBEX_REF unless it follows releases, as either installer writes it", () => {
  const unix = 'CUBEX_FORMAT=2\nCUBEX_REPO=gurmohitghuman/cubex\nCUBEX_REF=v0.8.2\nCUBEX_SOURCE=\n'
  assert.equal(pinnedFrom(unix), 'v0.8.2')
  assert.equal(pinnedFrom('CUBEX_FORMAT=2\r\nCUBEX_REF=v0.8.2\r\nCUBEX_SOURCE=\r\n'), 'v0.8.2')
  assert.equal(pinnedFrom("CUBEX_REF='my branch'\n"), 'my branch')
  assert.equal(pinnedFrom('CUBEX_REF=my\\ branch\n'), 'my branch')
  assert.equal(pinnedFrom('CUBEX_REF=main\n'), 'main')
  for (const text of ['CUBEX_REF=stable\n', 'CUBEX_REF=\n', "CUBEX_REF=''\n", 'CUBEX_REPO=x\n', '', null]) {
    assert.equal(pinnedFrom(text), null, String(text))
  }
})

await test('install.env is read only in a marked install folder with a .cubex-version', () => {
  fs.writeFileSync(installEnv, 'CUBEX_FORMAT=2\nCUBEX_REF=v0.8.2\n')
  running('v0.8.2 abc1234')
  assert.equal(runningVersion().pinned, null, 'no .cubex-home marker')
  fs.writeFileSync(marker, 'This folder is a Cubex install.\n')
  assert.equal(runningVersion().pinned, 'v0.8.2')
  running(null)
  assert.deepEqual(runningVersion(), { build: null, version: null, pinned: null })
  fs.rmSync(installEnv)
})

await test('a newer release: kept, update_available; one GET with a fixed User-Agent, nothing else', async () => {
  running('v0.8.9 abc1234\n')
  reply = release('v0.8.10')
  assert.equal(await check.checkReleaseNow(USER), true)
  const info = versionInfo(USER)
  assert.equal(info.version, 'v0.8.9')
  assert.equal(info.update_available, true)
  assert.equal(info.latest_release!.version, 'v0.8.10')
  assert.equal(info.latest_release!.published_at, '2026-11-12T15:04:05.000Z')
  assert.equal(info.latest_release!.notes_url, 'https://github.com/gurmohitghuman/cubex/releases/tag/v0.8.10')
  const req = seen.at(-1)!
  assert.equal(req.method, 'GET')
  assert.equal(req.url, '/repos/gurmohitghuman/cubex/releases/latest')
  assert.equal(req.headers['user-agent'], 'Cubex')
  assert.equal(req.headers.cookie, undefined)
  assert.equal(req.headers.authorization, undefined)
})

await test('an install pinned to its tag: update_available, with pinned_ref saying why cubex update stays', () => {
  fs.writeFileSync(installEnv, 'CUBEX_FORMAT=2\nCUBEX_REF=v0.8.9\n')
  assert.equal(versionInfo(USER).pinned_ref, 'v0.8.9')
  assert.equal(versionInfo(USER).update_available, true)
  fs.writeFileSync(installEnv, 'CUBEX_FORMAT=2\nCUBEX_REF=stable\n')
  assert.equal(versionInfo(USER).pinned_ref, null)
})

await test('the same release, or an older one: no update', async () => {
  reply = release('v0.8.9')
  assert.equal(await check.checkReleaseNow(USER), true)
  assert.equal(versionInfo(USER).update_available, false)
  reply = release('0.8.8')
  assert.equal(await check.checkReleaseNow(USER), true)
  assert.equal(versionInfo(USER).latest_release!.version, 'v0.8.8')
  assert.equal(versionInfo(USER).update_available, false)
})

await test('a build that is not a release, or not recorded: the latest release shows, update_available null', () => {
  for (const line of ['main 6071123', 'local 6071123 2026-11-13 10:00', null]) {
    running(line)
    const info = versionInfo(USER)
    assert.equal(info.version, null)
    assert.equal(info.build, line)
    assert.equal(info.latest_release!.version, 'v0.8.8')
    assert.equal(info.update_available, null)
  }
  running('v0.8.9 abc1234')
})

await test('rate limited, or an answer that is not a release: false, and the last good answer stays', async () => {
  const bad: Reply[] = [
    { status: 403, body: '{"message":"API rate limit exceeded"}', headers: { 'x-ratelimit-remaining': '0' } },
    { status: 429, body: '{}' }, { status: 500, body: '{}' }, { status: 200, body: 'not json' },
    release('v0.9.0', { draft: true }), release('v0.9.0-rc.1', { prerelease: true }), release('nightly'),
    { status: 200, body: JSON.stringify({ tag_name: 'v0.9.0', pad: 'x'.repeat(600 * 1024) }) },
  ]
  for (const r of bad) {
    reply = r
    assert.equal(await check.checkReleaseNow(USER), false, `${r.status} ${r.body.slice(0, 40)}`)
    assert.equal(versionInfo(USER).latest_release!.version, 'v0.8.8')
  }
})

await test('a bad date is dropped, the release kept', async () => {
  reply = release('v0.8.11', { published_at: 'soon' })
  assert.equal(await check.checkReleaseNow(USER), true)
  assert.equal(versionInfo(USER).latest_release!.published_at, null)
  assert.equal(versionInfo(USER).update_available, true)
})

await test('two checks at once send one request', async () => {
  const before = seen.length
  reply = release('v0.8.11')
  assert.deepEqual(await Promise.all([check.checkReleaseNow(USER), check.checkReleaseNow(USER)]), [true, true])
  assert.equal(seen.length, before + 1)
})

await test('turned off: the answer deleted, the automatic check asks nothing, a late answer not kept', async () => {
  store.setUpdateCheck(USER, false)
  let info = versionInfo(USER)
  assert.equal(info.update_check, false)
  assert.equal(info.latest_release, null)
  assert.equal(info.update_available, null)
  db.prepare('UPDATE settings SET release_tried_at = NULL WHERE user_id = ?').run(USER)
  const before = seen.length
  await check.checkDueReleases()
  assert.equal(seen.length, before)
  // On again, a check goes out, the check is turned off while it waits, then GitHub answers.
  store.setUpdateCheck(USER, true)
  let release_!: () => void
  hold = new Promise(r => { release_ = r })
  const pending = check.checkReleaseNow(USER)
  while (seen.length === before) await new Promise(r => setTimeout(r, 10))
  store.setUpdateCheck(USER, false)
  release_()
  hold = null
  assert.equal(await pending, true)
  info = versionInfo(USER)
  assert.equal(info.latest_release, null)
  assert.equal(store.readReleaseState(USER).latest, null)
  store.setUpdateCheck(USER, true)
})

await test('the automatic check: at most once a day, for every account due, with one request', async () => {
  db.prepare('UPDATE settings SET release_tried_at = NULL WHERE user_id = ?').run(USER)
  db.prepare("INSERT INTO users (id, password_hash) VALUES ('user-2', 'x')").run()
  reply = release('v0.8.10')
  const before = seen.length
  await check.checkDueReleases()
  assert.equal(seen.length, before + 1)
  for (const id of [USER, 'user-2']) assert.equal(versionInfo(id).latest_release!.version, 'v0.8.10', id)
  await check.checkDueReleases()
  await check.checkDueReleases(Date.now() + 23 * 3600_000)
  assert.equal(seen.length, before + 1)
  await check.checkDueReleases(Date.now() + 25 * 3600_000)
  assert.equal(seen.length, before + 2)
  db.prepare("DELETE FROM users WHERE id = 'user-2'").run()
})

await test('offline: false, nothing shows when nothing was kept, and the next start keeps the day', async () => {
  store.setUpdateCheck(USER, false)
  store.setUpdateCheck(USER, true)
  await new Promise<void>(r => { github.close(() => r()); github.closeAllConnections() })
  assert.equal(await check.checkReleaseNow(USER), false)
  const info = versionInfo(USER)
  assert.equal(info.version, 'v0.8.9')
  assert.equal(info.latest_release, null)
  assert.equal(info.update_available, null)
  assert.ok(store.readReleaseState(USER).triedAt, 'a failed check still counts for the day')
  assert.deepEqual(store.dueForReleaseCheck(new Date(Date.now() - 24 * 3600_000).toISOString()), [])
})

fs.rmSync(home, { recursive: true, force: true })
console.log('release check: all passed')
