import fs from 'node:fs'
import path from 'node:path'
import { test, expect, APIRequestContext } from '@playwright/test'
import { authedApi } from './helpers'
import { bearer, makeToken } from './api-v1-run-helpers'
import { call, callError, mcpClient, modernMcpClient } from './helpers-mcp'

// After an update, an agent learns what changed: the MCP instructions name the running release and what
// changed for agents in it (server/src/mcp/agent-changes.ts), and get_version with since (GET
// /api/v1/version?since= the same) lists every release after a version, oldest first. A since that is not
// a release is refused in the same words on both. A build that is not a release says so. The running
// version comes from a folder laid out like an install (CUBEX_TEST_HOME), as in settings-version.spec.ts.

const HOME = process.env.CUBEX_TEST_HOME || ''
const VERSION_FILE = path.join(HOME, 'app', '.cubex-version')
const AFTER = 'After an update, get_version with since set to the version you last used lists every change for '
  + 'agents after it.'
let token: string
let v1: APIRequestContext

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  if (!HOME) throw new Error('CUBEX_TEST_HOME not set: run via npm run e2e')
  fs.mkdirSync(path.dirname(VERSION_FILE), { recursive: true })
  fs.writeFileSync(path.join(HOME, '.cubex-home'), 'This folder is a Cubex install.\n')
  fs.writeFileSync(VERSION_FILE, 'v0.8.14 e2e0003\n')
  token = await makeToken(await authedApi(), ['read'], 'changes spec')
  v1 = await bearer(token)
})
test.afterAll(async () => {
  fs.rmSync(HOME, { recursive: true, force: true })
  await v1?.dispose()
})

test('the instructions name the release and what changed in it; get_version since lists the changes', async () => {
  const legacy = await mcpClient(token)
  const modern = await modernMcpClient(token)
  try {
    expect(legacy.getServerVersion()).toEqual({ name: 'cubex', version: 'v0.8.14' })
    const instructions = legacy.getInstructions() ?? ''
    expect(instructions).toMatch(/^Cubex is a spreadsheet workspace\. This server runs Cubex v0\.8\.14\. New for /)
    expect(instructions).toContain('New for agents in it: get_version takes since, a release like "v0.8.13"')
    expect(instructions).toContain(AFTER)

    const rest = await v1.get('/api/v1/version?since=v0.8.12')
    expect(rest.status()).toBe(200)
    const answer = await rest.json()
    expect(answer.version).toBe('v0.8.14')
    expect(answer.changes_since.since).toBe('v0.8.12')
    expect(answer.changes_since.note).toBeUndefined()
    // Oldest first: v0.8.13 added get_version, v0.8.14 gave it since.
    const [first, second] = answer.changes_since.releases
    expect([first.version, second.version]).toEqual(['v0.8.13', 'v0.8.14'])
    expect(first.changes).toContainEqual(expect.objectContaining({ change: 'added', tools: ['get_version'] }))
    expect(second.changes).toContainEqual(expect.objectContaining({ change: 'changed', tools: ['get_version'] }))
    expect(second.changes).toContainEqual(expect.objectContaining({ change: 'server' }))
    // Both eras answer what REST answers; "0.8.12" reads as v0.8.12.
    expect(await call(legacy, 'get_version', { since: 'v0.8.12' })).toEqual(answer)
    expect(await call(modern, 'get_version', { since: '0.8.12' })).toEqual(answer)
    // From the release before: only v0.8.14. Nothing after the running release; without since, no changes_since.
    expect((await call(modern, 'get_version', { since: 'v0.8.13' })).changes_since.releases).toEqual([second])
    expect((await call(modern, 'get_version', { since: 'v0.8.14' })).changes_since.releases).toEqual([])
    expect(await call(legacy, 'get_version', {})).not.toHaveProperty('changes_since')
    // Older than the list: what it has, and where the rest is.
    expect((await call(legacy, 'get_version', { since: 'v0.8.1' })).changes_since.note)
      .toMatch(/^Changes are listed for the releases after v0\.8\.12 only\./)

    // Not a release: refused in the same words on REST and MCP.
    const words = 'since must be a Cubex release like "v0.8.12", not "main e2e0003". A build that is not a release '
      + 'has no place in the list: pass the last release you used.'
    const bad = await v1.get(`/api/v1/version?since=${encodeURIComponent('main e2e0003')}`)
    expect([bad.status(), await bad.json()]).toEqual([400, { error: words }])
    expect(await callError(legacy, 'get_version', { since: 'main e2e0003' })).toBe(words)
    const twice = await v1.get('/api/v1/version?since=v0.8.12&since=v0.8.13')
    expect(twice.status()).toBe(400)
    expect((await twice.json()).error).toMatch(/not a list\./)
    const shaped = await v1.get('/api/v1/version?since[a]=1')
    expect([shaped.status(), (await shaped.json()).error]).toEqual([400, expect.stringMatching(/not an object\./)])
  } finally {
    await legacy.close()
    await modern.close()
  }
})

test('a build that is not a release says so in the instructions', async () => {
  fs.writeFileSync(VERSION_FILE, 'main e2e0004\n')
  const client = await mcpClient(token)
  try {
    expect(client.getServerVersion()).toEqual({ name: 'cubex', version: 'main e2e0004' })
    const start = 'Cubex is a spreadsheet workspace. This server runs a Cubex build that is not a release '
      + `(main e2e0004). ${AFTER} `
    expect((client.getInstructions() ?? '').slice(0, start.length)).toBe(start)
  } finally { await client.close() }
})
