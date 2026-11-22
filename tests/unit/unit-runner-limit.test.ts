// scripts/unit-tests.mjs's time limit on each test file: a file that never ends fails by name, it and every
// process it started are stopped, the run goes on to the next file and exits 1; a run within the limit is as
// before, and a limit that isn't a number of seconds over 0 is refused. The runner runs on a scratch copy of
// the repository's layout (its own tests/unit with two files), finding tsx in this checkout's node_modules
// through NODE_PATH: a link to node_modules inside a temp folder would be removed along with it. The limit
// here is 10 s, so a slow Windows runner still starts the file well within it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-runner-'))
const pidsFile = path.join(repo, 'pids.json')
fs.mkdirSync(path.join(repo, 'scripts'))
fs.mkdirSync(path.join(repo, 'tests', 'unit'), { recursive: true })
fs.copyFileSync(path.join('scripts', 'unit-tests.mjs'), path.join(repo, 'scripts', 'unit-tests.mjs'))
fs.writeFileSync(path.join(repo, 'package.json'), '{ "type": "module" }\n')
// Its checks pass, then neither it nor the process it started ever ends. The ids of tsx's process, the
// test's and the one it started go to a file.
fs.writeFileSync(path.join(repo, 'tests', 'unit', 'a-never-ends.test.ts'), [
  "import { spawn } from 'node:child_process'",
  "import fs from 'node:fs'",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
  'fs.writeFileSync(process.env.PIDS_FILE!, JSON.stringify([process.ppid, process.pid, child.pid]))',
  "console.log('a: all checks passed')",
  'setInterval(() => {}, 1000)',
].join('\n'))
fs.writeFileSync(path.join(repo, 'tests', 'unit', 'b-ends.test.ts'), "console.log('b: all checks passed')\n")

// The scratch runner over its files whose names contain `names`; never held past two minutes itself.
const run = (env: Record<string, string>, ...names: string[]) => {
  const started = Date.now()
  const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'unit-tests.mjs'), ...names], {
    cwd: repo, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL',
    env: { ...process.env, NODE_PATH: path.resolve('node_modules'), PIDS_FILE: pidsFile, ...env },
  })
  return { status: r.status, error: r.error, out: r.stdout, err: r.stderr, secs: (Date.now() - started) / 1000 }
}

// Gone, or a zombie no one has collected yet (Linux): a stopped process either way.
function alive(pid: number): boolean {
  try { process.kill(pid, 0) } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
  if (process.platform !== 'linux') return true
  try { return !/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return false }
}

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn()
  console.log(`  ok - ${name}`)
}

await test('a file that never ends fails by name, and the run goes on and exits 1', () => {
  const r = run({ UNIT_FILE_TIMEOUT_S: '10' })
  assert.equal(r.error, undefined, `the run itself never ended: ${r.err}`)
  assert.equal(r.status, 1, r.err)
  assert.match(r.out, /a: all checks passed/)
  assert.match(r.err, /\[x\] tests\/unit\/a-never-ends\.test\.ts did not end within 10 s: stopped it and every process/)
  assert.match(r.out, /b: all checks passed/)
  assert.match(r.err, /\[done\] 1 of 2 unit tests failed \(\d+s\):\n {2}a-never-ends\.test\.ts \(did not end within 10/)
  assert.ok(r.secs < 60, `took ${r.secs} s`)
})

await test('it and every process it started were stopped', async () => {
  const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8')) as number[]
  assert.equal(pids.length, 3)
  for (let i = 0; i < 50 && pids.some(alive); i++) await new Promise(res => setTimeout(res, 200))
  assert.deepEqual(pids.filter(alive), [], 'still running')
})

await test('a run within the limit is as before', () => {
  const r = run({}, 'b-ends')
  assert.equal(r.status, 0, r.err)
  assert.match(r.out, /b: all checks passed/)
  assert.match(r.out, /\[done\] all 1 unit tests passed/)
  assert.doesNotMatch(r.err, /did not end/)
})

await test('a limit that is not a number of seconds over 0 is refused', () => {
  for (const limit of ['0', '-5', 'soon']) {
    const r = run({ UNIT_FILE_TIMEOUT_S: limit })
    assert.equal(r.status, 2, `${limit}: ${r.err}`)
    assert.match(r.err, new RegExp(`UNIT_FILE_TIMEOUT_S must be a number of seconds over 0, not '${limit}'`))
  }
})

fs.rmSync(repo, { recursive: true, force: true })
console.log('unit-runner-limit: all passed')
