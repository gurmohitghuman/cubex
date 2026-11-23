// scripts/unit-tests.mjs's time limit on each test file: a file that never ends fails by name (on Linux, after
// what each of its processes' threads were doing), it and every process it started are stopped, the run goes on
// to the next file and exits 1; so is a file that ends by itself while those threads are printed. A run within
// the limit is as before, and a limit that isn't a number of seconds over 0 and up to Node's longest timer is
// refused. On macOS and Linux, a SIGKILL to the run's process group, or a SIGINT to the runner alone, still stops
// the running file and every process it started. The runner runs on a scratch copy of the repository's layout
// (its own tests/unit with three files), finding tsx in this checkout's node_modules through NODE_PATH: a link to
// node_modules inside a temp folder would be removed along with it. The limit here is 10 s, so a slow Windows
// runner still starts the file well within it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-runner-'))
const pidsFile = path.join(repo, 'pids.json')
fs.mkdirSync(path.join(repo, 'scripts'))
fs.mkdirSync(path.join(repo, 'tests', 'unit'), { recursive: true })
for (const f of ['unit-tests.mjs', 'unit-shards.mjs']) {
  fs.copyFileSync(path.join('scripts', f), path.join(repo, 'scripts', f))
}
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
// Like a-never-ends, but it ends by itself 10.4 s after tsx's process started: on Linux, while the runner prints
// its threads (from 10 s, for 1 s). The process it started never ends.
fs.writeFileSync(path.join(repo, 'tests', 'unit', 'c-ends-late.test.ts'), [
  "import { spawn } from 'node:child_process'",
  "import fs from 'node:fs'",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
  'child.unref()',
  'fs.writeFileSync(process.env.PIDS_FILE!, JSON.stringify([process.ppid, process.pid, child.pid]))',
  "console.log('c: all checks passed')",
  "// ms since tsx's process started; on Linux from its start time and the uptime, both in 1/100 s",
  'const since = () => {',
  "  if (process.platform !== 'linux') return performance.now()",
  "  const stat = fs.readFileSync(`/proc/${process.ppid}/stat`, 'utf8')",
  "  const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19])",
  "  return Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000 - ticks * 10",
  '}',
  "setTimeout(() => console.log('c: ended by itself'), 10_400 - since())",
].join('\n'))

// The scratch runner over its files whose names contain `names`; never held past two minutes itself.
const runner = path.join(repo, 'scripts', 'unit-tests.mjs')
const runEnv = { ...process.env, NODE_PATH: path.resolve('node_modules'), PIDS_FILE: pidsFile }
const run = (env: Record<string, string>, ...names: string[]) => {
  const started = Date.now()
  const r = spawnSync(process.execPath, [runner, ...names], {
    cwd: repo, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', env: { ...runEnv, ...env },
  })
  return { status: r.status, error: r.error, out: r.stdout, err: r.stderr, secs: (Date.now() - started) / 1000 }
}

// Gone, or a zombie no one has collected yet (Linux): a stopped process either way.
function alive(pid: number): boolean {
  try { process.kill(pid, 0) } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
  if (process.platform !== 'linux') return true
  try { return !/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return false }
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))

// Those still running after up to 10 s. They are stopped then, so a failed check leaves nothing behind: each
// case below collects what it checks, then cleans up, then checks.
async function leftOver(pids: number[]): Promise<number[]> {
  for (let i = 0; i < 50 && pids.some(alive); i++) await sleep(200)
  const left = pids.filter(alive)
  for (const pid of left) try { process.kill(pid, 'SIGKILL') } catch { /* it has ended */ }
  return left
}

// The scratch runner on a-never-ends, leading its own process group as a terminal's job does, once that file
// has written its process ids: the runner, how it ended and what it wrote to stderr, and those ids.
async function startNeverEnding() {
  fs.rmSync(pidsFile, { force: true })
  const child = spawn(process.execPath, [runner, 'a-never-ends'], {
    cwd: repo, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...runEnv, UNIT_FILE_TIMEOUT_S: '90' },
  })
  const out = { err: '' }
  child.stderr.on('data', d => { out.err += d })
  const ended = new Promise<string>(res => child.on('exit', (code, signal) => res(String(signal ?? code))))
  for (let i = 0; i < 300; i++) {
    try {
      return { child, ended, out, pids: JSON.parse(fs.readFileSync(pidsFile, 'utf8')) as number[] }
    } catch { /* not written yet */ }
    await sleep(200)
  }
  throw new Error(`a-never-ends never started: ${out.err}`)
}

// How the runner ended (its exit code or signal), or 'still running' after 20 s.
const within20s = (ended: Promise<string>) => Promise.race([ended, sleep(20_000).then(() => 'still running')])

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn()
  console.log(`  ok - ${name}`)
}

await test('a file that never ends fails by name, and the run goes on and exits 1', () => {
  const r = run({ UNIT_FILE_TIMEOUT_S: '10' }, 'a-never-ends', 'b-ends')
  assert.equal(r.error, undefined, `the run itself never ended: ${r.err}`)
  assert.equal(r.status, 1, r.err)
  assert.match(r.out, /a: all checks passed/)
  assert.match(r.err, /\[x\] tests\/unit\/a-never-ends\.test\.ts did not end within 10 s: stopped it and every process/)
  assert.match(r.out, /b: all checks passed/)
  assert.match(r.err, /\[done\] 1 of 2 unit tests failed \(\d+s\):\n {2}a-never-ends\.test\.ts \(did not end within 10/)
  assert.ok(r.secs < 60, `took ${r.secs} s`)
  if (process.platform === 'linux') {
    assert.match(r.err, /\[threads\] process \d+: .*a-never-ends\.test\.ts\n/)
    assert.match(r.err, /^ {2}(\d+ threads, )?[^:\n]+: [A-Za-z], in \S+, syscall \S+, CPU \+\d+ ticks in 1 s$/m)
    assert.ok(r.err.indexOf('[threads]') < r.err.indexOf('[x] tests/unit/a-never-ends'), 'threads after the [x] line')
  }
})

await test('it and every process it started were stopped', async () => {
  const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8')) as number[]
  assert.equal(pids.length, 3)
  assert.deepEqual(await leftOver(pids), [], 'still running')
})

await test('a file that ends by itself just past its limit is stopped with every process it started', async () => {
  const r = run({ UNIT_FILE_TIMEOUT_S: '10' }, 'c-ends-late')
  const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8')) as number[]
  const left = await leftOver(pids)
  assert.equal(r.status, 1, r.err)
  assert.match(r.err, /\[x\] tests\/unit\/c-ends-late\.test\.ts did not end within 10 s: stopped it and every process/)
  assert.deepEqual(left, [], 'still running')
  if (process.platform === 'linux') { // it ended during the print, and the print came first
    assert.match(r.out, /c: ended by itself/)
    assert.match(r.err, /\[threads\] process \d+: ended\n/)
    assert.ok(r.err.indexOf('[threads]') < r.err.indexOf('[x] tests/unit/c-ends-late'), 'threads after the [x] line')
  }
})

// Windows has no process groups or signals of this kind: taskkill stops a tree there, as checked above.
if (process.platform === 'win32') {
  console.log('  skip - a SIGKILL to the run, and a SIGINT to the runner alone (macOS and Linux only)')
} else {
  await test('a SIGKILL to the run\'s process group stops the running file and every process it started', async () => {
    const { child, ended, pids } = await startNeverEnding()
    process.kill(-child.pid!, 'SIGKILL')
    const how = await within20s(ended)
    const left = await leftOver([child.pid!, ...pids])
    assert.equal(how, 'SIGKILL')
    assert.deepEqual(left, [], 'still running')
  })

  await test('a SIGINT to the runner alone stops the running file and every process it started', async () => {
    const { child, ended, out, pids } = await startNeverEnding()
    process.kill(child.pid!, 'SIGINT')
    const how = await within20s(ended)
    const left = await leftOver([child.pid!, ...pids])
    assert.equal(how, '130', out.err)
    assert.match(out.err, /\[stopped\] interrupted after \d+s/)
    assert.deepEqual(left, [], 'still running')
  })
}

await test('a run within the limit is as before', () => {
  const r = run({}, 'b-ends')
  assert.equal(r.status, 0, r.err)
  assert.match(r.out, /b: all checks passed/)
  assert.match(r.out, /\[done\] all 1 unit tests passed/)
  assert.doesNotMatch(r.err, /did not end/)
})

await test('a limit that is not a number of seconds over 0 and up to 2147483 is refused', () => {
  for (const limit of ['0', '-5', 'soon', '2147484', '99999999']) {
    const r = run({ UNIT_FILE_TIMEOUT_S: limit })
    assert.equal(r.status, 2, `${limit}: ${r.err}`)
    assert.match(r.err, new RegExp(`must be a number of seconds over 0 and up to 2147483, not '${limit}'`))
  }
  const r = run({ UNIT_FILE_TIMEOUT_S: '2147483' }, 'b-ends')
  assert.equal(r.status, 0, r.err)
  assert.doesNotMatch(r.err, /TimeoutOverflowWarning|did not end/)
})

fs.rmSync(repo, { recursive: true, force: true })
console.log('unit-runner-limit: all passed')
