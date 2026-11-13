// The running version (lib/cubex-version.ts): release versions compare as numbers; the installer's
// .cubex-version gives the build and its release; install.env gives the ref an install made with --ref
// stays on, as either installer writes it, read only in a folder the installer marked, beside a
// .cubex-version, and again at every use (the install command run again with --ref on an install
// already on that version rewrites it without a restart).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A folder laid out like an install, named before the module loads.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cubex-home-'))
fs.mkdirSync(path.join(home, 'app'))
const versionFile = path.join(home, 'app', '.cubex-version')
const installEnv = path.join(home, 'install.env')
const marker = path.join(home, '.cubex-home')
process.env.CUBEX_TEST_HOME = home
const { compareVersions, parseTag, pinnedFrom, runningBuild, runningFrom, runningVersion } =
  await import('../../server/src/lib/cubex-version')

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

await test('a pin made while Cubex runs is seen at once, and serverInfo reads the build without it', () => {
  fs.writeFileSync(marker, 'This folder is a Cubex install.\n')
  running('v0.8.12 abc1234')
  fs.writeFileSync(installEnv, 'CUBEX_FORMAT=2\nCUBEX_REF=stable\n')
  assert.equal(runningVersion().pinned, null)
  fs.writeFileSync(installEnv, 'CUBEX_FORMAT=2\nCUBEX_REF=v0.8.12\n')
  assert.equal(runningVersion().pinned, 'v0.8.12')
  assert.deepEqual(runningBuild(), { build: 'v0.8.12 abc1234', version: 'v0.8.12' })
})

fs.rmSync(home, { recursive: true, force: true })
console.log('cubex version: all passed')
