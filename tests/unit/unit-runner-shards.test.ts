// CI splits the unit tests over 3 runners per platform (.github/workflows/checks.yml), each running
// scripts/unit-tests.mjs with UNIT_SHARD=k/n. Every test file must run on exactly one of them: none twice, none on no
// runner at all, which would pass CI without ever running. Checked here: the share each file goes to
// (scripts/unit-shards.mjs) for lists of 0 to 12 files and 1 to 5 shares, and for this checkout's own tests; a
// UNIT_SHARD that isn't k/n is refused; the runner runs only its share's files, printing each one's start, and a share
// with none passes; and the workflow's list of shards is 1 to the n it passes to UNIT_SHARD, with each platform's
// result under the name main's required check uses. The runner runs on a scratch copy of the repository's layout,
// finding tsx in this checkout's node_modules through NODE_PATH, as unit-runner-limit.test.ts does.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { filesOfShard, parseShard } from '../../scripts/unit-shards.mjs'

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn()
  console.log(`  ok - ${name}`)
}

// Every file in exactly one share, each share in the list's order, and shares no more than one file apart.
function checkSplit(files: string[], n: number): void {
  const shares = Array.from({ length: n }, (_, i) => filesOfShard(files, { k: i + 1, n }))
  const all = shares.flat()
  assert.equal(all.length, files.length, `${files.length} files in ${n}: ${JSON.stringify(shares)}`)
  assert.deepEqual([...all].sort(), [...files].sort(), `${files.length} files in ${n}`)
  for (const share of shares) assert.deepEqual(share, files.filter(f => share.includes(f)), 'in the list order')
  const sizes = shares.map(s => s.length)
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${files.length} files in ${n}: sizes ${sizes}`)
}

await test('every file goes to exactly one share, in order, the shares at most one file apart', () => {
  for (let count = 0; count <= 12; count++) {
    const files = Array.from({ length: count }, (_, i) => `f${String(i).padStart(2, '0')}.test.ts`)
    for (let n = 1; n <= 5; n++) checkSplit(files, n)
    assert.deepEqual(filesOfShard(files, null), files, 'no share: every file')
  }
  const own = fs.readdirSync(path.join('tests', 'unit')).filter(f => f.endsWith('.test.ts')).sort()
  assert.ok(own.includes('unit-runner-shards.test.ts'))
  for (let n = 1; n <= 5; n++) checkSplit(own, n)
})

await test('UNIT_SHARD unset or empty means every file; k/n is read; anything else is refused', () => {
  assert.equal(parseShard(undefined), null)
  assert.equal(parseShard(''), null)
  assert.deepEqual(parseShard('1/1'), { k: 1, n: 1 })
  assert.deepEqual(parseShard('2/3'), { k: 2, n: 3 })
  assert.deepEqual(parseShard('3/3'), { k: 3, n: 3 })
  for (const bad of ['0/3', '4/3', '1/0', '0/0', '3', '/3', '1/', 'a/b', '-1/3', '1.5/3', ' 1/3', '1/3 ', '1/3/3']) {
    const quoted = bad.replace(/[.*+?/]/g, '\\$&')
    assert.throws(() => parseShard(bad), new RegExp(`UNIT_SHARD must be k/n .*, not '${quoted}'`))
  }
})

// A scratch repository with five test files, each printing its own name.
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-shards-'))
fs.mkdirSync(path.join(repo, 'scripts'))
fs.mkdirSync(path.join(repo, 'tests', 'unit'), { recursive: true })
for (const f of ['unit-tests.mjs', 'unit-shards.mjs']) {
  fs.copyFileSync(path.join('scripts', f), path.join(repo, 'scripts', f))
}
fs.writeFileSync(path.join(repo, 'package.json'), '{ "type": "module" }\n')
const scratch = ['a', 'b', 'c', 'd', 'e']
for (const f of scratch) fs.writeFileSync(path.join(repo, 'tests', 'unit', `${f}.test.ts`), `console.log('ran ${f}')\n`)
const run = (shard: string | undefined, ...names: string[]) => {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_PATH: path.resolve('node_modules') }
  if (shard === undefined) delete env.UNIT_SHARD
  else env.UNIT_SHARD = shard
  const r = spawnSync(process.execPath, [path.join(repo, 'scripts', 'unit-tests.mjs'), ...names], {
    cwd: repo, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', env,
  })
  return { status: r.status, out: r.stdout, err: r.stderr, ran: [...r.stdout.matchAll(/^ran (\w)$/gm)].map(m => m[1]) }
}

await test('the runner runs only its share of the files, and the shares together run each file once', () => {
  const first = run('1/2')
  assert.equal(first.status, 0, first.err)
  assert.deepEqual(first.ran, ['a', 'c', 'e'])
  assert.match(first.out, /^\[shard 1\/2\] 3 of 5 unit test files$/m)
  assert.match(first.out, /^\[done\] all 3 unit tests of shard 1\/2 passed/m)
  const second = run('2/2')
  assert.equal(second.status, 0, second.err)
  assert.deepEqual(second.ran, ['b', 'd'])
  const whole = run(undefined)
  assert.equal(whole.status, 0, whole.err)
  assert.deepEqual(whole.ran, scratch)
  assert.match(whole.out, /^\[done\] all 5 unit tests passed/m)
  const starts = [...whole.out.matchAll(/^\[(\d)\/5\] tests\/unit\/(\w)\.test\.ts, \d+ s in$/gm)].map(m => m[1] + m[2])
  assert.deepEqual(starts, ['1a', '2b', '3c', '4d', '5e'], 'each file\'s start, numbered')
  assert.doesNotMatch(whole.out, /shard/)
})

await test('a name filter comes first, then the share; a share left with no files passes', () => {
  const r = run('2/2', 'c')
  assert.equal(r.status, 0, r.err)
  assert.deepEqual(r.ran, [])
  assert.match(r.out, /^\[shard 2\/2\] 0 of 1 unit test files$/m)
  assert.match(r.out, /^\[done\] no unit tests of shard 2\/2$/m)
})

await test('a UNIT_SHARD that is not k/n stops the runner before any test, with exit 2', () => {
  for (const bad of ['4/3', 'second']) {
    const r = run(bad)
    assert.equal(r.status, 2, r.err)
    assert.deepEqual(r.ran, [])
    assert.match(r.err, /UNIT_SHARD must be k\/n/)
  }
})

fs.rmSync(repo, { recursive: true, force: true })

await test('CI runs shards 1 to n with UNIT_SHARD k/n, and keeps each platform\'s result under its old name', () => {
  const checks = fs.readFileSync(path.join('.github', 'workflows', 'checks.yml'), 'utf8')
  const list = [...checks.matchAll(/^ {8}shard: \[([\d, ]+)\]$/gm)]
  assert.equal(list.length, 1, 'one list of shards')
  const shards = list[0][1].split(',').map(s => Number(s.trim()))
  const totals = [...checks.matchAll(/UNIT_SHARD: \$\{\{ matrix\.shard \}\}\/(\d+)$/gm)].map(m => Number(m[1]))
  assert.equal(totals.length, 1, 'one UNIT_SHARD')
  assert.deepEqual(shards, Array.from({ length: totals[0] }, (_, i) => i + 1))
  const ci = fs.readFileSync(path.join('.github', 'workflows', 'ci.yml'), 'utf8')
  for (const [job, runner, name] of [
    ['linux', 'ubuntu-latest', 'Typecheck + Unit tests + Build'],
    ['windows', 'windows-latest', 'Typecheck + Unit tests + Build (Windows)'],
  ]) {
    const title = `${job[0].toUpperCase()}${job.slice(1)}`
    assert.ok(ci.includes(`  ${job}:\n    name: ${title}\n    uses: ./.github/workflows/checks.yml\n`
      + `    with:\n      os: ${runner}\n`), `${job} runs checks.yml on ${runner}`)
    assert.ok(ci.includes(`  ${job}-result:\n    name: ${name}\n    needs: ${job}\n    if: \${{ always() }}\n`),
      `${name}: after ${job}, whatever its result`)
    assert.ok(ci.includes(`          RESULT: \${{ needs.${job}.result }}\n`), `${name} reads ${job}'s result`)
  }
  assert.equal([...ci.matchAll(/^ {10}test "\$RESULT" = success$/gm)].length, 2, 'each result passes only on success')
})

console.log('unit-runner-shards: all passed')
