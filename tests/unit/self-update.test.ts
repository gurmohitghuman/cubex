// Settings' "Update now" (lib/self-update.ts, routes/settings-version.ts), on a folder laid out like an install
// (CUBEX_TEST_HOME: app/.cubex-version, .cubex-home, install.env): where the updater starts on each platform, the
// lock a start takes, how this install updates (the button, pinned, a source checkout), each refusal (no newer
// release, an update already running, runs going; a paused run doesn't count), a start recorded, how a run reads
// back (running, done, failed with the log's last lines, an updater gone without a word), the route's answers, and
// on Linux and macOS a real run of bin/cubex-update-run.sh against a stand-in `cubex` that fails, then one that
// succeeds.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cubex-self-update-'))
process.env.CUBEX_TEST_HOME = home
delete process.env.INVOCATION_ID // a CI runner's own systemd unit: the real start here is the detached one
fs.mkdirSync(path.join(home, 'app', 'bin'), { recursive: true })
for (const f of ['cubex-update-run.sh', 'cubex-update-run.ps1']) {
  fs.copyFileSync(path.resolve('bin', f), path.join(home, 'app', 'bin', f))
}

const { db } = await import('../../server/src/lib/db')
const { runMigrations } = await import('../../server/src/db/migrate')
const su = await import('../../server/src/lib/self-update')
const routeMod = await import('../../server/src/routes/settings-version')
const { keepReleaseAnswer } = await import('../../server/src/lib/release-store')
runMigrations()
console.error = () => {}

let failures = 0
async function ok(label: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const put = (name: string, text: string) => fs.writeFileSync(path.join(home, name), text)
const gone = (name: string) => fs.rmSync(path.join(home, name), { force: true })
const has = (name: string) => fs.existsSync(path.join(home, name))
const status = () => JSON.parse(fs.readFileSync(path.join(home, 'update-status.json'), 'utf8'))
const installed = (on: boolean) => (on ? put('.cubex-home', '') : gone('.cubex-home'))
put('app/.cubex-version', 'v0.8.46 abc1234\n')
installed(true)
const fresh = () => ['update.lock', 'update-status.json', 'update.log', 'cubex-update-run.sh'].forEach(gone)
// A pid that was alive and isn't any more.
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid!

const uid = uuid(), sid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id, password_hash) VALUES (?, ?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?, ?, ?)').run(tid, uid, 'T')
db.prepare('INSERT INTO sheets (id, table_id, user_id, name) VALUES (?, ?, ?, ?)').run(sid, tid, uid, 'S')
const run = (state: string) => {
  const id = uuid()
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status)
    VALUES (?, ?, ?, 'A', 'p', 'm', ?)`).run(id, sid, uid, state)
  return id
}

await ok('the updater starts outside the service on each platform: a unit of its own only beside Cubex\'s own unit',
  () => {
  const own = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/cubex.service\n'
  const runner = '0::/system.slice/actions.runner.gurmohitghuman-cubex.runner.service\n'
  assert.equal(su.starterFor('linux', { INVOCATION_ID: 'x' }, own), 'systemd')
  assert.equal(su.starterFor('linux', { INVOCATION_ID: 'x' }, '1:name=systemd:/user.slice/cubex.service\r\n'),
    'systemd', 'cgroup v1')
  assert.equal(su.starterFor('linux', { INVOCATION_ID: 'x', CUBEX_SERVICE_UNIT: 'cubex-2' },
    '0::/user.slice/cubex-2.service'), 'systemd', 'a unit named otherwise')
  // Started from another unit (a CI runner's): the installer starts Cubex again from inside the updater, which a
  // unit of the updater's own would stop as it ends.
  assert.equal(su.starterFor('linux', { INVOCATION_ID: 'x' }, runner), 'detached')
  assert.equal(su.starterFor('linux', { INVOCATION_ID: 'x' }, null), 'detached')
  assert.equal(su.starterFor('linux', {}, own), 'detached')
  assert.equal(su.starterFor('darwin', { INVOCATION_ID: 'x' }, own), 'detached')
  assert.equal(su.starterFor('win32', {}), 'windows')
})

await ok('a lock holds while its updater lives, or for two minutes after a start', () => {
  const now = Date.parse('2026-11-26T12:00:00Z')
  assert.equal(su.lockHeld(null, now), false)
  assert.equal(su.lockHeld(`${process.pid}\n`, now), true)
  assert.equal(su.lockHeld('123\n', now, () => false), false)
  assert.equal(su.lockHeld('starting 2026-11-26T11:59:00.000Z\n', now), true)
  assert.equal(su.lockHeld('starting 2026-11-26T11:57:00.000Z\n', now), false)
  assert.equal(su.lockHeld('junk', now), false)
})

await ok('how this install updates: the button, pinned to a ref, a source checkout', () => {
  assert.equal(su.updateHow(), 'button')
  put('install.env', "CUBEX_REF='stable'\n")
  assert.equal(su.updateHow(), 'button')
  put('install.env', "CUBEX_REF='v0.8.40'\n")
  assert.equal(su.updateHow(), 'pinned')
  gone('install.env')
  installed(false)
  if (!fs.existsSync('/.dockerenv')) assert.equal(su.updateHow(), 'source')
  installed(true)
})

await ok('refused: no newer release, another way to update, runs going (a paused one is fine)', () => {
  fresh()
  for (const latest of [null, 'v0.8.46', 'v0.8.45', 'main']) {
    assert.equal((su.startUpdate(latest) as { fail?: string }).fail, 'current', String(latest))
  }
  put('install.env', "CUBEX_REF='v0.8.40'\n")
  const pinned = su.startUpdate('v0.8.47') as { fail: string; message: string }
  assert.equal(pinned.fail, 'how')
  assert.match(pinned.message, /cubex update --ref/)
  gone('install.env')
  const going = run('running')
  const out = su.startUpdate('v0.8.47') as { fail: string; message: string }
  assert.equal(out.fail, 'runs')
  assert.match(out.message, /A run is going/)
  db.prepare("UPDATE ai_runs SET status = 'paused' WHERE id = ?").run(going)
  const calls: unknown[] = []
  su.setUpdateStartForTests((...a) => { calls.push(a) })
  assert.ok('ok' in su.startUpdate('v0.8.47'))
  assert.equal(calls.length, 1)
  db.prepare('DELETE FROM ai_runs').run()
})

await ok('a start: the script copied, the versions kept, the lock taken; a second start refused', () => {
  fresh()
  const calls: unknown[][] = []
  su.setUpdateStartForTests((...a) => { calls.push(a) })
  const out = su.startUpdate('v0.8.47')
  assert.ok('ok' in out, JSON.stringify(out))
  assert.deepEqual({ state: out.ok.state, from: out.ok.from, to: out.ok.to }, { state: 'running', from: 'v0.8.46',
    to: 'v0.8.47' })
  const script = path.join(home, process.platform === 'win32' ? 'cubex-update-run.ps1' : 'cubex-update-run.sh')
  assert.deepEqual(calls, [[su.updaterStarter(), home, script, 'v0.8.46', 'v0.8.47']])
  assert.ok(fs.existsSync(script))
  assert.match(fs.readFileSync(path.join(home, 'update.lock'), 'utf8'), /^starting /)
  assert.equal((su.startUpdate('v0.8.47') as any).fail, 'running')
  su.setUpdateStartForTests(null)
})

await ok('how a run reads back: done, failed with its last lines, gone without a word, running', () => {
  fresh()
  put('update-status.json', '{"from":"v0.8.46","to":"v0.8.47","started_at":"x","code":0,"ended_at":"y"}')
  assert.equal(su.updateRun()!.state, 'done')
  const lines = Array.from({ length: 20 }, (_, i) => `\u001b[32mline ${i}\u001b[0m`).join('\n')
  put('update.log', `${lines}\n\nThe new version didn't start, so the previous one is back.\n`)
  put('update-status.json', '﻿{"from":"v0.8.46","to":"v0.8.47","code":2}')
  const failed = su.updateRun()!
  assert.equal(failed.state, 'failed')
  assert.equal(failed.code, 2)
  assert.ok(!failed.log.includes('\u001b') && failed.log.endsWith('the previous one is back.'), failed.log)
  assert.equal(failed.log.split('\n').length, 15)
  // As Windows PowerShell writes it: UTF-8 with a byte order mark (bin/cubex-update-run.ps1).
  put('update.log', '\uFEFFInstalling Cubex\r\nThe new version didn\'t start, so the previous one is back.\r\n')
  assert.equal(su.updateRun()!.log, 'Installing Cubex\nThe new version didn\'t start, so the previous one is back.')
  put('update-status.json', '{"from":"v0.8.46","to":"v0.8.47","started_at":"x"}')
  put('update.lock', `${deadPid()}\n`)
  assert.deepEqual([su.updateRun()!.state, su.updateRun()!.code], ['failed', null])
  put('update.lock', `${process.pid}\n`)
  assert.equal(su.updateRun()!.state, 'running')
  put('update-status.json', 'not json')
  assert.equal(su.updateRun(), null)
})

type Handle = (req: object, res: object) => unknown
type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> } }
const post = ((routeMod as unknown as { default: { stack: Layer[] } }).default.stack
  .find(l => l.route?.path === '/version/update' && l.route.methods.post)!).route!.stack[0].handle
const call = () => {
  const res = { code: 200, body: null as any,
    status(c: number) { this.code = c; return this }, json(b: unknown) { this.body = b; return this } }
  post({ userId: uid, body: {} }, res)
  return res
}

await ok('the route: 400 naming what to run elsewhere, 409 with nothing newer, 202 with how it is going', () => {
  fresh()
  installed(false)
  if (!fs.existsSync('/.dockerenv')) {
    const r = call()
    assert.equal(r.code, 400)
    assert.match(r.body.error, /source checkout/)
  }
  installed(true)
  assert.equal(call().code, 409)
  const at = new Date().toISOString()
  keepReleaseAnswer(uid, { version: 'v0.8.47', published_at: null, checked_at: at }, at)
  su.setUpdateStartForTests(() => {})
  const r = call()
  assert.equal(r.code, 202, JSON.stringify(r.body))
  assert.equal(r.body.self_update.how, 'button')
  assert.equal(r.body.self_update.run.state, 'running')
  assert.equal(r.body.self_update.run.to, 'v0.8.47')
  su.setUpdateStartForTests(null)
})

const until = async (what: () => boolean, ms = 15_000) => {
  for (const end = Date.now() + ms; !what() && Date.now() < end;) await new Promise(r => setTimeout(r, 50))
  return what()
}
if (process.platform !== 'win32') {
  await ok('a real run: the script runs cubex update outside the server, then says how it ended', async () => {
    for (const [code, said] of [[3, 'failed'], [0, 'done']] as const) {
      fresh()
      put('app/bin/cubex', `#!/bin/sh\necho "update $1"\nprintf '\\033[32mDownloading\\033[0m\\n'\nexit ${code}\n`)
      fs.chmodSync(path.join(home, 'app/bin/cubex'), 0o755)
      const out = su.startUpdate('v0.8.47')
      assert.ok('ok' in out, JSON.stringify(out))
      assert.ok(await until(() => has('update-status.json') && 'code' in status() && !has('update.lock')),
        `the updater ended: ${fs.readFileSync(path.join(home, 'update-status.json'), 'utf8')}`)
      const r = su.updateRun()!
      assert.deepEqual([r.state, r.code, r.from, r.to], [said, code, 'v0.8.46', 'v0.8.47'])
      assert.equal(r.log, 'update update\nDownloading')
    }
  })
}

fs.rmSync(home, { recursive: true, force: true })
if (failures > 0) { console.error(`${failures} self-update check(s) failed`); process.exit(1) }
console.log('self-update: all passed')
process.exit(0)
