// scripts/unit-tests.mjs's flake policy (Hermes Agent's, WORKFLOW.md 7): a file that fails runs once more in a fresh
// process. One that passes then is green but listed under FLAKY; one that fails again fails the run as before, once
// in the list; UNIT_FILE_RETRIES=0 runs each file once. The runner runs on a scratch copy of the repository's layout,
// finding tsx through NODE_PATH, as unit-runner-limit does.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { passed } from './ends-on-its-own'

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-runner-flaky-'))
const marks = path.join(repo, 'marks')
fs.mkdirSync(marks)
fs.mkdirSync(path.join(repo, 'scripts'))
fs.mkdirSync(path.join(repo, 'tests', 'unit'), { recursive: true })
for (const f of ['unit-tests.mjs', 'unit-shards.mjs']) {
  fs.copyFileSync(path.join('scripts', f), path.join(repo, 'scripts', f))
}
fs.writeFileSync(path.join(repo, 'package.json'), '{ "type": "module" }\n')
// Fails on its first run (it leaves a mark), passes on the next.
fs.writeFileSync(path.join(repo, 'tests', 'unit', 'a-flaky.test.ts'), [
  "import fs from 'node:fs'",
  "const mark = `${process.env.MARKS}/a`",
  "if (!fs.existsSync(mark)) { fs.writeFileSync(mark, ''); console.log('a: FAIL'); process.exitCode = 1 }",
  "else console.log('a: passed')",
].join('\n'))
fs.writeFileSync(path.join(repo, 'tests', 'unit', 'b-fails.test.ts'), "console.log('b: FAIL'); process.exitCode = 1\n")
fs.writeFileSync(path.join(repo, 'tests', 'unit', 'c-passes.test.ts'), "console.log('c: passed')\n")

const runner = path.join(repo, 'scripts', 'unit-tests.mjs')
const runEnv: NodeJS.ProcessEnv = { ...process.env, NODE_PATH: path.resolve('node_modules'), MARKS: marks }
// The outer run's settings stay out: a share, GitHub's warnings, retries turned off or another time limit.
for (const k of ['UNIT_SHARD', 'GITHUB_ACTIONS', 'UNIT_FILE_RETRIES', 'UNIT_FILE_TIMEOUT_S']) delete runEnv[k]
const run = (env: Record<string, string>, ...names: string[]) => {
  for (const f of fs.readdirSync(marks)) fs.rmSync(path.join(marks, f))
  const r = spawnSync(process.execPath, [runner, ...names], {
    cwd: repo, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', env: { ...runEnv, ...env },
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

// A file that passes on its retry: green, listed as flaky; one failing twice fails the run, once in the list.
let r = run({})
assert.equal(r.status, 1, r.out)
assert.match(r.out, /\[!\] tests\/unit\/a-flaky\.test\.ts failed \(exit 1\); running it once more in a fresh process/)
assert.match(r.out, /FLAKY: 1 unit test file\(s\) passed only on a retry/)
assert.match(r.out, /\n {2}a-flaky\.test\.ts \(failed with exit 1, then passed\)/)
assert.equal(r.out.match(/b: FAIL/g)?.length, 2, 'b-fails runs twice')
assert.equal(r.out.match(/c: passed/g)?.length, 1, 'c-passes runs once')
assert.match(r.out, /\[done\] 1 of 3 unit tests failed \(\d+s\):\n {2}b-fails\.test\.ts\n/)
assert.doesNotMatch(r.out, /\[done\][^\n]*\n {2}a-flaky/, 'the flaky file is not a failure')

// Only the flaky file: the run is green, and says so.
r = run({}, 'a-flaky')
assert.equal(r.status, 0, r.out)
assert.match(r.out, /\[done\] all 1 unit tests passed/)
assert.match(r.out, /FLAKY: 1 unit test file/)

// On GitHub, a warning names it on the pull request.
r = run({ GITHUB_ACTIONS: 'true' }, 'a-flaky')
assert.match(r.out, /::warning title=Flaky unit test::tests\/unit\/a-flaky\.test\.ts failed, then passed on its retry/)

// UNIT_FILE_RETRIES=0: each file once, a flaky one fails.
r = run({ UNIT_FILE_RETRIES: '0' }, 'a-flaky')
assert.equal(r.status, 1, r.out)
assert.doesNotMatch(r.out, /running it once more|FLAKY/)

fs.rmSync(repo, { recursive: true, force: true })
console.log('unit-runner-flaky: all passed')
passed()
