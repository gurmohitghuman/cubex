// scripts/unit-tests.mjs names a test file whose process was slow to start (a machine stall, not the test): past
// UNIT_SLOW_START_S it says so while it waits, then again with the time it took; a file that starts at once gets
// neither line, and a value that isn't a number of seconds is refused. A stall is stood in for by a preload that
// sleeps 1.5 s in the test's process before the runner's note of its start. The runner runs on a scratch copy of
// the repository's layout, finding tsx in this checkout's node_modules through NODE_PATH (as unit-runner-limit).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-runner-start-'))
fs.mkdirSync(path.join(repo, 'scripts'))
fs.mkdirSync(path.join(repo, 'tests', 'unit'), { recursive: true })
for (const f of ['unit-tests.mjs', 'unit-shards.mjs']) {
  fs.copyFileSync(path.join('scripts', f), path.join(repo, 'scripts', f))
}
fs.writeFileSync(path.join(repo, 'package.json'), '{ "type": "module" }\n')
fs.writeFileSync(path.join(repo, 'tests', 'unit', 'a-quick.test.ts'), "console.log('a: all checks passed')\n")
const stall = path.join(repo, 'stall.cjs')
fs.writeFileSync(stall, [
  "if (/\\.test\\.ts$/.test(process.argv[1] || '')) {",
  '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)',
  '}',
].join('\n'))

const runEnv: NodeJS.ProcessEnv = { ...process.env, NODE_PATH: path.resolve('node_modules') }
delete runEnv.UNIT_SHARD
delete runEnv.UNIT_SLOW_START_S
// Not this runner's own note of a start (when it runs this file): it would note the scratch file's start first.
delete runEnv.NODE_OPTIONS
delete runEnv.UNIT_STARTED_FILE
const run = (env: Record<string, string>) => {
  const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'unit-tests.mjs')], {
    cwd: repo, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', env: { ...runEnv, ...env },
  })
  return { status: r.status, out: r.stdout, err: r.stderr }
}

let failures = 0
function check(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).message)
  }
}

try {
  check('a file that starts at once: no slow-start line', () => {
    const r = run({})
    assert.equal(r.status, 0, r.err)
    assert.match(r.out, /a: all checks passed/)
    assert.doesNotMatch(r.out, /slow start/)
  })
  check('a stalled start: named while it waits, then with the time it took; the file still runs', () => {
    const r = run({ UNIT_SLOW_START_S: '1', NODE_OPTIONS: `--require ${JSON.stringify(stall)}` })
    assert.equal(r.status, 0, r.err)
    assert.match(r.out, /a: all checks passed/)
    assert.match(r.out, /\[slow start\] tests\/unit\/a-quick\.test\.ts: its process hasn't started after 1 s/)
    const took = r.out.match(/\[slow start\] tests\/unit\/a-quick\.test\.ts: its process took ([\d.]+) s to start/)
    assert.ok(took, r.out)
    assert.ok(Number(took[1]) >= 1.5, `took ${took[1]} s`)
  })
  check('UNIT_SLOW_START_S must be a number of seconds', () => {
    const r = run({ UNIT_SLOW_START_S: 'soon' })
    assert.equal(r.status, 2)
    assert.match(r.err, /UNIT_SLOW_START_S must be a number of seconds/)
  })
} finally {
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

if (failures > 0) { console.error(`${failures} unit-runner-start check(s) failed`); process.exit(1) }
console.log('unit-runner-start: all assertions passed')
