// Over 200 lines: one stand-in GitHub and one database serve every case in order; split, each file would
// repeat that setup. The version files themselves are in cubex-version.test.ts.
// The release check (services/release-check.ts) against a stand-in GitHub on 127.0.0.1, never the real
// one: a newer, the same and an older release; offline, rate limited and answers that aren't a release
// (each keeps the last good answer); the check turned off (the answer deleted, nothing asked, a late
// answer not kept); at most one automatic check a day; and what the answer says for a release, a
// branch, a local source, no version file and a pinned install (the files themselves:
// cubex-version.test.ts).
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
fs.writeFileSync(path.join(home, '.cubex-home'), 'This folder is a Cubex install.\n')
// Read when the modules load: the stand-in's address and the install folder.
process.env.RELEASE_CHECK_URL = `http://127.0.0.1:${port}/repos/gurmohitghuman/cubex/releases/latest`
process.env.CUBEX_TEST_HOME = home

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
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

// "Check now" with no check in the last minute, so it asks (the cooldown has its own test below).
const askNow = async (): Promise<boolean> => {
  db.prepare('UPDATE settings SET release_tried_at = NULL WHERE user_id = ?').run(USER)
  return (await check.checkReleaseNow(USER)).reached
}

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn()
  console.log(`  ok - ${name}`)
}

await test('a newer release: kept, update_available; one GET with a fixed User-Agent, nothing else', async () => {
  running('v0.8.9 abc1234\n')
  reply = release('v0.8.10')
  assert.equal(await askNow(), true)
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
  assert.equal(await askNow(), true)
  assert.equal(versionInfo(USER).update_available, false)
  reply = release('0.8.8')
  assert.equal(await askNow(), true)
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
    assert.equal(await askNow(), false, `${r.status} ${r.body.slice(0, 40)}`)
    assert.equal(versionInfo(USER).latest_release!.version, 'v0.8.8')
  }
})

await test('a bad date is dropped, the release kept', async () => {
  reply = release('v0.8.11', { published_at: 'soon' })
  assert.equal(await askNow(), true)
  assert.equal(versionInfo(USER).latest_release!.published_at, null)
  assert.equal(versionInfo(USER).update_available, true)
})

await test('two checks at once send one request', async () => {
  const before = seen.length
  reply = release('v0.8.11')
  assert.deepEqual(await Promise.all([askNow(), askNow()]), [true, true])
  assert.equal(seen.length, before + 1)
})

await test('Check now within a minute of the last check answers from what it kept, without asking', async () => {
  reply = release('v0.8.10')
  assert.equal(await askNow(), true)
  // A good answer carries the time its check went out, so a later failed check is never taken for it.
  const kept = store.readReleaseState(USER)
  assert.equal(kept.latest!.checked_at, kept.triedAt)
  const before = seen.length
  reply = release('v0.8.11')
  assert.deepEqual(await check.checkReleaseNow(USER), { reached: true, asked: false })
  assert.equal(seen.length, before)
  assert.equal(versionInfo(USER).latest_release!.version, 'v0.8.10')
  // A minute later it asks again.
  assert.deepEqual(await check.checkReleaseNow(USER, Date.now() + 61_000), { reached: true, asked: true })
  assert.equal(seen.length, before + 1)
  assert.equal(versionInfo(USER).latest_release!.version, 'v0.8.11')
  // The automatic check counts too, and a last check that failed says so again without asking.
  reply = { status: 403, body: '{}', headers: { 'x-ratelimit-remaining': '0' } }
  db.prepare('UPDATE settings SET release_tried_at = NULL WHERE user_id = ?').run(USER)
  await check.checkDueReleases()
  assert.equal(seen.length, before + 2)
  assert.deepEqual(await check.checkReleaseNow(USER), { reached: false, asked: false })
  assert.equal(seen.length, before + 2)
  assert.equal(versionInfo(USER).latest_release!.version, 'v0.8.11', 'the last good answer stays')
  // A last check stamped in the future (the clock went back) doesn't hold Check now off.
  db.prepare('UPDATE settings SET release_tried_at = ? WHERE user_id = ?')
    .run(new Date(Date.now() + 3600_000).toISOString(), USER)
  reply = release('v0.8.11')
  assert.deepEqual(await check.checkReleaseNow(USER), { reached: true, asked: true })
  assert.equal(seen.length, before + 3)
  // Turned off and on again right after a check: nothing is kept, so Check now asks.
  store.setUpdateCheck(USER, false)
  store.setUpdateCheck(USER, true)
  assert.deepEqual(await check.checkReleaseNow(USER), { reached: true, asked: true })
  assert.equal(seen.length, before + 4)
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
  const pending = askNow()
  while (seen.length === before) await new Promise(r => setTimeout(r, 10))
  store.setUpdateCheck(USER, false)
  release_()
  hold = null
  assert.equal(await pending, true)
  info = versionInfo(USER)
  assert.equal(info.latest_release, null)
  assert.deepEqual(store.readReleaseState(USER), { updateCheck: false, latest: null, triedAt: null })
  // On again: Check now asks at once rather than answering from the check that was dropped.
  store.setUpdateCheck(USER, true)
  assert.deepEqual(await check.checkReleaseNow(USER), { reached: true, asked: true })
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
  assert.equal(await askNow(), false)
  const info = versionInfo(USER)
  assert.equal(info.version, 'v0.8.9')
  assert.equal(info.latest_release, null)
  assert.equal(info.update_available, null)
  assert.ok(store.readReleaseState(USER).triedAt, 'a failed check still counts for the day')
  assert.deepEqual(store.dueForReleaseCheck(new Date(Date.now() - 24 * 3600_000).toISOString()), [])
})

fs.rmSync(home, { recursive: true, force: true })
console.log('release check: all passed')
