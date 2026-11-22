// scripts/release.sh cut's tool list check (agent_changes_check): a release with changes for agents is cut
// only once the commit records its tool list (tests/unit/mcp-tool-list.json, docs/releasing.md). It runs in
// bash with the script's own set -euo pipefail, on a scratch repository holding the full-size list, which is
// more than a pipe holds (64 KB): refused before the record and with the file gone, allowed after it, five
// times over (a reader that stopped at the match would cut git show off and fail the pipe), and a release
// without lines needs no record, even when the list records an older release. The script is for macOS and
// Linux, so this is skipped on Windows.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

if (process.platform === 'win32') {
  console.log('skipped on Windows: scripts/release.sh runs in bash on macOS and Linux')
  process.exit(0)
}

const LIST = fs.readFileSync(path.join('tests', 'unit', 'mcp-tool-list.json'), 'utf8')
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tool-list-'))
const git = (...args: string[]): string => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
    { cwd: repo, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  fs.writeFileSync(path.join(repo, file), text)
}
const commit = (message: string): string => {
  git('add', '-A')
  git('commit', '-q', '-m', message)
  return git('rev-parse', 'HEAD')
}
const changes = (version: string) =>
  `export const AGENT_CHANGES = [\n  {\n    version: '${version}',\n    changes: [],\n  },\n]\n`
const recording = (release: string) => LIST.replace(/^ {2}"release": "v\d+\.\d+\.\d+",$/m, `  "release": "${release}",`)

// The cut's check as `cut v0.8.40` runs it after the tag prev ('' for none, as on the first release): exit 0
// when the cut may go on, else 1 and why.
const cut = (target: string, prev = '') => spawnSync('bash',
  ['-c', 'source scripts/release.sh && agent_changes_check "$1" v0.8.40 "$2"', 'check', prev, target],
  { cwd: repo, encoding: 'utf8' })

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn()
  console.log(`  ok - ${name}`)
}

git('init', '-q')
write('scripts/release.sh', fs.readFileSync(path.join('scripts', 'release.sh'), 'utf8'))
write('server/src/mcp/agent-changes.ts', changes('v0.8.40'))
write('tests/unit/mcp-tool-list.json', recording('v0.8.38'))
const before = commit('lines for v0.8.40, the list recorded is v0.8.38')
write('tests/unit/mcp-tool-list.json', recording('v0.8.40'))
const recorded = commit('v0.8.40 recorded')
fs.rmSync(path.join(repo, 'tests', 'unit', 'mcp-tool-list.json'))
const gone = commit('no list')
// On the commit before the record, whose list is v0.8.38's: a check that asked every release for a record would
// refuse it.
git('checkout', '-q', before)
write('server/src/mcp/agent-changes.ts', changes('v0.8.38'))
const noLines = commit('no lines after v0.8.38')

await test(`the list is bigger than a pipe holds (${LIST.length} bytes)`, () => {
  assert.ok(LIST.length > 65_536)
  assert.match(git('show', `${recorded}:tests/unit/mcp-tool-list.json`).slice(0, 40), /"release": "v0\.8\.40"/)
})

await test('refused before the list is recorded, and saying how to record it', () => {
  const r = cut(before)
  assert.equal(r.status, 1, r.stderr)
  assert.match(r.stderr, /v0\.8\.40 has changes for agents, and tests\/unit\/mcp-tool-list\.json on main/)
  assert.match(r.stderr, /doesn't record v0\.8\.40's tool list/)
  assert.match(r.stderr, /MCP_TOOL_LIST_RECORD=v0\.8\.40 npm run test:unit -- mcp-tool-list/)
})

await test('allowed once it is recorded, every time', () => {
  for (let i = 0; i < 5; i++) {
    const r = cut(recorded)
    assert.equal(r.status, 0, `try ${i + 1}: ${r.stderr}`)
  }
})

await test('refused when the list is gone', () => {
  assert.equal(cut(gone).status, 1)
})

await test('a release without lines needs no record', () => {
  const r = cut(noLines, 'v0.8.39')
  assert.equal(r.status, 0, r.stderr)
})

fs.rmSync(repo, { recursive: true, force: true })
console.log('release-tool-list-check: all passed')
