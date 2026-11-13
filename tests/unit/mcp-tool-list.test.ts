// The MCP tools (names and input schemas, as tools/list publishes them) against the list recorded for the
// last release (mcp-tool-list.json) and the changes file (server/src/mcp/agent-changes.ts). Every tool
// added, removed or renamed since that release, or whose input schema changed, has a line under the next
// release, and every line under it matches what the tools show. Wording (descriptions, titles) is left
// out of the comparison: only what a call must send counts.
//
// After a release whose changes the file lists, record its tool list, on main, before any tool changes
// for the next release (this test refuses lines for a second release until then):
//   MCP_TOOL_LIST_RECORD=v0.8.13 npm run test:unit -- mcp-tool-list
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { mcpHttpKit } from './mcp-http-kit'
import changesMod from '../../server/src/mcp/agent-changes'
import versionMod from '../../server/src/lib/cubex-version'
import readMod from '../../server/src/services/version-changes'
const { AGENT_CHANGES, CHANGES_RECORDED_AFTER } = changesMod as typeof import('../../server/src/mcp/agent-changes')
const { parseTag, compareVersions } = versionMod as typeof import('../../server/src/lib/cubex-version')
const { replacedTools } = readMod as typeof import('../../server/src/services/version-changes')

type Schemas = Record<string, unknown>
const FILE = path.join('tests', 'unit', 'mcp-tool-list.json')
const CHANGES = 'server/src/mcp/agent-changes.ts'
const RECORD = process.env.MCP_TOOL_LIST_RECORD
const { check, done, crash, modern } = mcpHttpKit('mcp-tool-list')

const exact = (v: string) => { const t = parseTag(v); return !!t && `v${t.major}.${t.minor}.${t.patch}` === v }
const newer = (a: string, b: string) => compareVersions(parseTag(a)!, parseTag(b)!) > 0
const nextPatch = (v: string) => { const t = parseTag(v)!; return `v${t.major}.${t.minor}.${t.patch + 1}` }

// A schema without its wording, keys and required names sorted. A property named "description" is a
// schema (an object), so only the keywords go.
function contract(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(contract)
  if (!node || typeof node !== 'object') return node
  const kept = Object.entries(node).filter(([k, v]) =>
    !(['description', 'title', '$schema'].includes(k) && typeof v === 'string') && k !== 'examples')
  return Object.fromEntries(kept.sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) =>
    [k, k === 'required' && Array.isArray(v) ? [...v].sort() : contract(v)]))
}

async function main() {
  const res = await modern('tools/list')
  const listed = JSON.parse(res.text).result.tools as Array<{ name: string; inputSchema: unknown }>
  const current: Schemas = Object.fromEntries(listed.map(t => [t.name, contract(t.inputSchema)])
    .sort(([a], [b]) => String(a).localeCompare(String(b))))
  const recorded = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { release: string; tools: Schemas }
  const after = AGENT_CHANGES.filter(r => newer(r.version, recorded.release))
  const lines = after.flatMap(r => r.changes)
  const next = after[0]?.version ?? nextPatch(recorded.release)
  const has = (kind: string, tool: string) => lines.some(c => c.change === kind && c.tools?.includes(tool))

  // Tool changes since the recorded release that no line covers.
  function missing(): string[] {
    const out: string[] = []
    for (const name of Object.keys(current)) {
      if (!(name in recorded.tools)) {
        if (!has('added', name) && !lines.some(c => c.change === 'renamed' && c.replaced_by === name)) {
          out.push(`${name} is new: add an "added" line`)
        }
      } else if (!isDeepStrictEqual(current[name], recorded.tools[name]) && !has('changed', name)) {
        out.push(`${name}'s input schema changed: add a "changed" line saying what a call sends now`)
      }
    }
    for (const name of Object.keys(recorded.tools)) {
      if (!(name in current) && !has('removed', name) && !has('renamed', name)) {
        out.push(`${name} is gone: add a "removed" or "renamed" line naming what replaces it`)
      }
    }
    return out.map(m => `${m}, under ${next} in ${CHANGES}`)
  }
  // Lines after the recorded release that the tools contradict.
  function wrong(): string[] {
    const out: string[] = []
    for (const c of lines) {
      for (const tool of c.tools ?? []) {
        const now = tool in current, then = tool in recorded.tools
        const ok = c.change === 'added' ? now && !then : c.change === 'changed' ? now && then : !now && then
        if (!ok) out.push(`"${c.change}" ${tool}: it is ${now ? '' : 'not '}a tool now and was ${then ? '' : 'not '}`
          + `one in ${recorded.release}`)
      }
      if (c.replaced_by && !(c.replaced_by in current)) out.push(`${c.replaced_by} (replaced_by) is not a tool`)
    }
    return out
  }

  await check('the changes file is well formed', () => {
    const versions = AGENT_CHANGES.map(r => r.version)
    assert.ok(versions.every(exact), `versions are vX.Y.Z: ${versions.join(', ')}`)
    versions.forEach((v, i) => assert.ok(i === 0 || newer(versions[i - 1], v), `newest first, once each: ${v}`))
    assert.ok(versions.every(v => newer(v, CHANGES_RECORDED_AFTER)), `all after ${CHANGES_RECORDED_AFTER}`)
    for (const r of AGENT_CHANGES) for (const c of r.changes) {
      const where = `${r.version} "${c.summary.slice(0, 40)}"`
      assert.ok(['added', 'changed', 'removed', 'renamed', 'server'].includes(c.change), where)
      assert.equal(c.change === 'server', !c.tools?.length, `${where}: tools names the tools, except on "server"`)
      assert.ok((c.tools ?? []).every(t => /^[A-Za-z0-9_.-]{1,128}$/.test(t)), `${where}: tool names`)
      if (c.change === 'renamed') assert.ok(c.tools?.length === 1 && c.replaced_by, `${where}: one name, replaced_by`)
      else if (c.change !== 'removed') assert.equal(c.replaced_by, undefined, `${where}: replaced_by`)
      for (const text of c.details === undefined ? [c.summary] : [c.summary, c.details]) {
        assert.ok(/^\S.{9,239}\.$/.test(text) && !text.includes('\u2014'), `${where}: one plain sentence or two`)
      }
    }
  })

  await check(`at most one release is listed after ${recorded.release}, the release recorded`, () => {
    if (after.length > 1) {
      assert.fail(`${CHANGES} lists ${after.map(r => r.version).join(' and ')} after ${recorded.release}. `
        + `${after[1].version} is out: record its tool list first (top of this file).`)
    }
  })

  await check(`every tool change since ${recorded.release} has a line`, () => assert.deepEqual(missing(), []))
  await check(`every line after ${recorded.release} matches the tools`, () => assert.deepEqual(wrong(), []))

  await check('no removed or renamed tool name is a tool now', () => {
    assert.deepEqual([...replacedTools().keys()].filter(name => name in current), [])
  })

  if (RECORD) {
    await check(`record the tool list as ${RECORD}'s`, () => {
      assert.ok(exact(RECORD) && newer(RECORD, recorded.release), `a release after ${recorded.release}: ${RECORD}`)
      assert.ok(after.every(r => r.version === RECORD), `${CHANGES} lists ${after.map(r => r.version)} after `
        + `${recorded.release}: ${RECORD}'s changes go under ${RECORD}, and a later release's mean the tools on `
        + `this commit are not ${RECORD}'s`)
      assert.deepEqual([...missing(), ...wrong()], [])
      let tags = ''
      try { tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }) } catch { /* no git here */ }
      assert.ok(!tags || tags.split('\n').includes(RECORD), `${RECORD} is not a release tag (git fetch --tags)`)
      fs.writeFileSync(FILE, JSON.stringify({ release: RECORD, tools: current }, null, 2) + '\n')
    })
  }
  done()
}

main().catch(crash)
