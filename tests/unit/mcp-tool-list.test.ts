// The MCP tools (names and input schemas, as tools/list publishes them) against the list recorded for the
// last release with changes for agents (mcp-tool-list.json) and the changes file (server/src/mcp/
// agent-changes.ts). Every tool added, removed or renamed since that release, or whose input schema
// changed, has a line under the next release, and every line under it matches what the tools show.
// Wording (descriptions, titles) is left out: only what a call must send counts.
//
// Where this checkout has the release tags (not CI, which checks out one commit), it also checks that a
// release out with changes for agents has its list recorded, that what the newest tag shipped of the
// changes file is unchanged, and it names the next release after the newest tag. To record a release's
// list, read from that release's own code, so it can be done any time after the tag:
//   MCP_TOOL_LIST_RECORD=vX.Y.Z npm run test:unit -- mcp-tool-list
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { mcpHttpKit } from './mcp-http-kit'
import { CHANGES, Recorded, Schemas, byName, exact, newer, nextPatch, releaseTags, shippedPart, toolsAt }
  from './mcp-tool-list-kit'
import changesMod from '../../server/src/mcp/agent-changes'
import readMod from '../../server/src/services/version-changes'
const { AGENT_CHANGES, CHANGES_RECORDED_AFTER } = changesMod as typeof import('../../server/src/mcp/agent-changes')
const { replacedTools } = readMod as typeof import('../../server/src/services/version-changes')
type AgentChange = import('../../server/src/mcp/agent-changes').AgentChange

const FILE = path.join('tests', 'unit', 'mcp-tool-list.json')
const RECORD = process.env.MCP_TOOL_LIST_RECORD
const { check, done, crash, modern } = mcpHttpKit('mcp-tool-list')

// The lines of the releases after from, up to and with to.
const linesAfter = (from: string, to?: string): AgentChange[] => AGENT_CHANGES
  .filter(r => newer(r.version, from) && (!to || !newer(r.version, to))).flatMap(r => r.changes)

// Tool changes from base to tools that no line covers, each saying what to add under next.
function missing(base: Recorded, tools: Schemas, lines: AgentChange[], next: string): string[] {
  const has = (kind: string, tool: string) => lines.some(c => c.change === kind && c.tools?.includes(tool))
  const out: string[] = []
  for (const name of Object.keys(tools)) {
    if (!(name in base.tools)) {
      if (!has('added', name) && !lines.some(c => c.change === 'renamed' && c.replaced_by === name)) {
        out.push(`${name} is new: add an "added" line`)
      }
    } else if (!isDeepStrictEqual(tools[name], base.tools[name]) && !has('changed', name)) {
      out.push(`${name}'s input schema changed: add a "changed" line saying what a call sends now`)
    }
  }
  for (const name of Object.keys(base.tools)) {
    if (!(name in tools) && !has('removed', name) && !has('renamed', name)) {
      out.push(`${name} is gone: add a "removed" or "renamed" line naming what replaces it`)
    }
  }
  return out.map(m => `${m}, under ${next} in ${CHANGES}`)
}

// Lines the tools contradict: what each says against base's tools and these.
function wrong(base: Recorded, tools: Schemas, lines: AgentChange[]): string[] {
  const out: string[] = []
  for (const c of lines) {
    for (const tool of c.tools ?? []) {
      const now = tool in tools, then = tool in base.tools
      const ok = c.change === 'added' ? now && !then : c.change === 'changed' ? now && then : !now && then
      if (!ok) {
        out.push(`"${c.change}" ${tool}: it is ${now ? '' : 'not '}a tool now and was ${then ? '' : 'not '}one in `
          + base.release)
      }
    }
    if (c.replaced_by && !(c.replaced_by in tools)) out.push(`${c.replaced_by} (replaced_by) is not a tool`)
  }
  return out
}

// What the tag shipped of the changes file, if text changed it.
function shippedEdit(tag: string, text: string): string | null {
  const part = shippedPart(tag, text)
  return !part || part.shipped === part.now ? null : `${CHANGES} changes what ${tag} shipped (${part.first} and `
    + `older). A change after ${tag} goes under a later release.`
}

async function main() {
  const current = byName(JSON.parse((await modern('tools/list')).text).result.tools)
  const text = fs.readFileSync(CHANGES, 'utf8')
  const tags = releaseTags()
  let recorded = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Recorded

  if (RECORD) {
    await check(`record ${RECORD}'s tool list, from its own code`, () => {
      assert.ok(exact(RECORD) && newer(RECORD, recorded.release), `a release after ${recorded.release}: ${RECORD}`)
      assert.ok(tags.includes(RECORD), `${RECORD} is not a release tag here (git fetch --tags)`)
      const edit = shippedEdit(RECORD, text)
      if (edit) assert.fail(edit)
      const tools = toolsAt(RECORD)
      const lines = linesAfter(recorded.release, RECORD)
      assert.deepEqual([...missing(recorded, tools, lines, RECORD), ...wrong(recorded, tools, lines)], [])
      recorded = { release: RECORD, tools }
      fs.writeFileSync(FILE, JSON.stringify(recorded, null, 2) + '\n')
    })
  }

  const after = AGENT_CHANGES.filter(r => newer(r.version, recorded.release))
  const lines = after.flatMap(r => r.changes)
  const out = tags[0] && newer(tags[0], recorded.release) ? tags[0] : recorded.release
  const next = after[0] && newer(after[0].version, out) ? after[0].version : nextPatch(out)

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
      for (const s of c.details === undefined ? [c.summary] : [c.summary, c.details]) {
        assert.ok(/^\S.{9,239}\.$/.test(s) && !s.includes('\u2014'), `${where}: one plain sentence or two`)
      }
    }
  })

  await check(`a release out with changes for agents has its list recorded (${tags.length} tags here)`, () => {
    const unrecorded = tags.filter(t => newer(t, recorded.release) && AGENT_CHANGES.some(r => r.version === t))
    if (unrecorded.length) {
      assert.fail(`${unrecorded[0]} is out with changes for agents, and the list recorded is ${recorded.release}'s. `
        + `Record ${unrecorded[0]}'s (top of this file).`)
    }
  })

  await check(`at most one release is listed after ${recorded.release}, the release recorded`, () => {
    if (after.length > 1) {
      assert.fail(`${CHANGES} lists ${after.map(r => r.version).join(' and ')} after ${recorded.release}. `
        + `${after[1].version} is out: record its tool list first (top of this file).`)
    }
  })

  await check(`what the newest tag (${tags[0] ?? 'none here'}) shipped of the changes file is unchanged`, () => {
    const edit = tags[0] ? shippedEdit(tags[0], text) : null
    if (edit) assert.fail(edit)
  })

  await check(`every tool change since ${recorded.release} has a line`,
    () => assert.deepEqual(missing(recorded, current, lines, next), []))
  await check(`every line after ${recorded.release} matches the tools`,
    () => assert.deepEqual(wrong(recorded, current, lines), []))

  await check('no removed or renamed tool name is a tool now', () => {
    assert.deepEqual([...replacedTools().keys()].filter(name => name in current), [])
  })
  done()
}

main().catch(crash)
