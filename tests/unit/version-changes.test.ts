// What changed for agents (services/version-changes.ts, from server/src/mcp/agent-changes.ts): since read
// as a release and refused in plain words otherwise, the releases after it oldest first, the note when it
// is older than the list; the instructions' lines for the running release; and through /mcp in both
// eras, a call to a removed or renamed tool answered with what replaced it (a tool error), any other
// unknown name still -32602, and get_version's since.
import assert from 'node:assert/strict'
import { mcpHttpKit } from './mcp-http-kit'
import changesMod from '../../server/src/mcp/agent-changes'
import readMod from '../../server/src/services/version-changes'
const { AGENT_CHANGES } = changesMod as typeof import('../../server/src/mcp/agent-changes')
const { changesSince, versionNote, replacedTools } =
  readMod as typeof import('../../server/src/services/version-changes')
type Release = import('../../server/src/mcp/agent-changes').ReleaseChanges

const { check, done, crash, modern, legacy } = mcpHttpKit('version-changes')
const line = (summary: string) => ({ change: 'server' as const, summary })
const LIST: Release[] = [
  { version: 'v0.9.1', changes: [{ change: 'renamed', tools: ['old_rows'], replaced_by: 'read_rows',
    summary: 'old_rows is now read_rows.', details: 'Call read_rows with the same arguments.' }] },
  { version: 'v0.9.0', changes: [line('One.'), line('Two.'), line('Three.'), line('Four.')] },
  { version: 'v0.8.13', changes: [{ change: 'removed', tools: ['ping_sheet'], summary: 'ping_sheet is gone.' },
    { change: 'added', tools: ['old_rows'], summary: 'New tool old_rows.' }] },
]
const AFTER = 'After an update, get_version with since set to the version you last used lists every change for '
  + 'agents after it. '

async function main() {
  await check('since: the releases after it, oldest first; a note when it is older than the list', () => {
    const ok = (since: unknown) => { const r = changesSince(since, LIST); assert.ok('ok' in r); return r.ok }
    assert.deepEqual(ok('v0.9.0'), { since: 'v0.9.0', releases: [LIST[0]] })
    assert.deepEqual(ok('0.8.12').releases.map(r => r.version), ['v0.8.13', 'v0.9.0', 'v0.9.1'])
    assert.equal(ok(' v0.8.12 ').since, 'v0.8.12')
    assert.deepEqual(ok('v0.9.1').releases, [])
    assert.deepEqual(ok('v1.0.0').releases, [])
    assert.equal(ok('v0.8.12').note, undefined)
    assert.equal(ok('v0.8.11').note, 'Changes are listed for the releases after v0.8.12 only. For earlier ones, '
      + 'read the release notes: https://github.com/gurmohitghuman/cubex/releases')
  })

  await check('since that is not a release is refused, saying what to send', () => {
    const refused = (since: unknown) => {
      const r = changesSince(since, LIST)
      assert.ok('error' in r)
      return r.error
    }
    assert.equal(refused('main 6071123'), 'since must be a Cubex release like "v0.8.12", not "main 6071123". A '
      + 'build that is not a release has no place in the list: pass the last release you used.')
    for (const bad of ['', 'abc', 'v0.8', 'v0.8.12-rc1', 'latest', 'x'.repeat(41)]) {
      assert.match(refused(bad), /^since must/)
    }
    assert.match(refused('y'.repeat(100)), new RegExp(`not "${'y'.repeat(40)}"\\.`))
    assert.match(refused(['v0.8.12', 'v0.8.13']), /not a list\./)
    assert.match(refused(12), /not a number\./)
    assert.match(refused({ a: '1' }), /not an object\./)
  })

  await check('the instructions: the running release and what changed in it, in a few lines', () => {
    assert.equal(versionNote({ version: 'v0.8.13', build: 'v0.8.13 abc' }, LIST), 'This server runs Cubex v0.8.13. '
      + 'New for agents in it: ping_sheet is gone. New tool old_rows. ' + AFTER)
    assert.equal(versionNote({ version: 'v0.9.0', build: 'v0.9.0' }, LIST),
      'This server runs Cubex v0.9.0. New for agents in it: One. Two. Three. And 1 more. ' + AFTER)
    assert.equal(versionNote({ version: 'v0.9.2', build: 'v0.9.2' }, LIST),
      'This server runs Cubex v0.9.2, with no changes for agents. ' + AFTER)
    assert.equal(versionNote({ version: null, build: 'main 6071123' }, LIST),
      'This server runs a Cubex build that is not a release (main 6071123). ' + AFTER)
    assert.equal(versionNote({ version: null, build: null }, LIST), 'This server does not record its Cubex version. '
      + AFTER)
  })

  await check('removed and renamed tools, read oldest first', () => {
    assert.deepEqual([...replacedTools(LIST)], [
      ['ping_sheet', 'ping_sheet was removed in Cubex v0.8.13. ping_sheet is gone. Your tool list is older than this '
        + 'server: list the tools again.'],
      ['old_rows', 'old_rows was renamed to read_rows in Cubex v0.9.1: call read_rows instead. Call read_rows with the '
        + 'same arguments. Your tool list is older than this server: list the tools again.']])
    // A later release that brings a name back as a tool: no longer answered as replaced.
    const back: Release = { version: 'v0.9.2',
      changes: [{ change: 'added', tools: ['ping_sheet'], summary: 'Back.' }] }
    assert.deepEqual([...replacedTools([back, ...LIST]).keys()], ['old_rows'])
  })

  // From here on, the server reads the file with one more release in it: one renamed and one removed tool.
  AGENT_CHANGES.unshift({ version: 'v99.0.0', changes: [
    { change: 'renamed', tools: ['get_versions'], replaced_by: 'get_version',
      summary: 'get_versions is now get_version.' },
    { change: 'removed', tools: ['ping_sheet'], replaced_by: 'get_sheet', summary: 'ping_sheet is gone.' }] })
  const renamed = 'get_versions was renamed to get_version in Cubex v99.0.0: call get_version instead. get_versions '
    + 'is now get_version. Your tool list is older than this server: list the tools again.'

  await check('a call to a renamed or removed tool says what replaced it, as a tool error, in both eras', async () => {
    const call = (era: typeof modern, name: string, args: Record<string, unknown> = {}) => era === modern
      ? modern('tools/call', { name, arguments: args }, name) : legacy('tools/call', { name, arguments: args })
    for (const era of [modern, legacy]) {
      const res = JSON.parse((await call(era, 'get_versions', { since: 'v1' })).text)
      assert.equal(res.result.isError, true)
      // A 2026-07-28 answer is a complete result, like any tool's.
      assert.equal(res.result.resultType, era === modern ? 'complete' : undefined)
      assert.deepEqual(JSON.parse(res.result.content[0].text), { error: renamed })
      const gone = JSON.parse((await call(era, 'ping_sheet')).text).result
      assert.match(JSON.parse(gone.content[0].text).error,
        /^ping_sheet was removed in Cubex v99\.0\.0\. Call get_sheet instead\. ping_sheet is gone\./)
      // Any other unknown name is still the protocol error.
      assert.equal(JSON.parse((await call(era, 'nope')).text).error.code, -32602)
    }
  })

  await check('get_version with since, in both eras; a bad since is a tool error', async () => {
    for (const era of [modern, legacy]) {
      const ask = async (since: string) => JSON.parse((era === modern
        ? await modern('tools/call', { name: 'get_version', arguments: { since } }, 'get_version')
        : await legacy('tools/call', { name: 'get_version', arguments: { since } })).text).result
      const answer = JSON.parse((await ask('v0.8.12')).content[0].text)
      // Every release in the file (all after v0.8.12), the added v99.0.0 last: oldest first.
      assert.deepEqual(answer.changes_since.releases.map((r: Release) => r.version),
        AGENT_CHANGES.map(r => r.version).reverse())
      assert.equal(answer.changes_since.releases.at(-1).version, 'v99.0.0')
      assert.equal(answer.changes_since.since, 'v0.8.12')
      const bad = await ask('soon')
      assert.equal(bad.isError, true)
      assert.match(JSON.parse(bad.content[0].text).error,
        /^since must be a Cubex release like "v0\.8\.12", not "soon"\./)
    }
  })

  await check('server/discover: the instructions name the version, here not recorded', async () => {
    const { instructions } = JSON.parse((await modern('server/discover')).text).result
    assert.ok(instructions.startsWith('Cubex is a spreadsheet workspace. This server does not record its Cubex '
      + 'version. After an update, get_version with since'), instructions.slice(0, 200))
  })
  done()
}

main().catch(crash)
