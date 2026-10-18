import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// Rerun target modes. The incident: an AI
// rerun meant to retry 10 failed rows re-ran all 9,675 because the implicit
// default ("empty or errored") matches every blank cell on a fresh column.
// Contract now: an AI rerun over MCP MUST state its target — mode or row_ids.
// Runs as test4 so its rate/table buckets don't collide with other specs.


async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'e2e-rerun-modes', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

function parseResult(res: { content?: Array<{ type: string; text?: string }> }): any {
  const text = res.content?.find(c => c.type === 'text')?.text
  return text ? JSON.parse(text) : null
}

function isError(res: any): boolean {
  return res?.isError === true
}

function errorText(res: any): string {
  return res?.content?.find((c: any) => c.type === 'text')?.text ?? ''
}

test('MCP AI rerun requires an explicit target', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'rerun-modes')
  const client = await mcpClient(token)

  // A rerun needs a real run id to address. We don't need the run to have
  // SUCCEEDED — the mode guard runs before the run is even looked up, which is
  // the point: the check is cheap and happens before anything bills.
  const bogusRunId = '00000000-0000-4000-8000-000000000000'

  // No mode, no row_ids → refused with actionable guidance, BEFORE any lookup.
  const noTarget = await client.callTool({
    name: 'control_run',
    arguments: { run_type: 'ai', run_id: bogusRunId, action: 'rerun' },
  })
  expect(isError(noTarget)).toBe(true)
  const msg = errorText(noTarget)
  // The message must name every option — an agent reads this to recover.
  expect(msg).toContain('errored')
  expect(msg).toContain('empty')
  expect(msg).toContain('missing')
  expect(msg).toContain('all')
  // And it must be the MODE guard talking, not a "run not found" — proving the
  // guard fires before the run lookup (so a real run can't slip past it).
  expect(msg.toLowerCase()).not.toContain('not found')

  // With a mode supplied, the guard passes and we reach the real lookup, which
  // legitimately 404s on the bogus id. Different error = guard cleared.
  const withMode = await client.callTool({
    name: 'control_run',
    arguments: { run_type: 'ai', run_id: bogusRunId, action: 'rerun', mode: 'errored' },
  })
  expect(isError(withMode)).toBe(true)
  expect(errorText(withMode).toLowerCase()).toContain('not found')

  // row_ids alone also satisfies the guard (explicit subset, no mode needed).
  const withRowIds = await client.callTool({
    name: 'control_run',
    arguments: {
      run_type: 'ai', run_id: bogusRunId, action: 'rerun',
      row_ids: ['00000000-0000-4000-8000-000000000001'],
    },
  })
  expect(isError(withRowIds)).toBe(true)
  expect(errorText(withRowIds).toLowerCase()).toContain('not found')

  await client.close()
})

test('MCP HTTP rerun takes every rerun mode, and refuses an unknown one', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await seedSheet(api, 2)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'rerun-modes-http')
  const client = await mcpClient(token)

  const bogusRunId = '00000000-0000-4000-8000-000000000000'

  // An HTTP API column's status cell reads like an AI column's: ❌ failed, blank
  // or "Condition not met" not run, a fingerprinted result out of date. Every
  // mode passes the guard and reaches the lookup.
  for (const mode of ['errored', 'empty', 'missing', 'all', 'out_of_date', 'empty_or_out_of_date']) {
    const res = await client.callTool({
      name: 'control_run',
      arguments: { run_type: 'http', run_id: bogusRunId, action: 'rerun', mode },
    })
    expect(isError(res)).toBe(true)
    expect(errorText(res).toLowerCase()).toContain('not found')
  }
  const unknown = await client.callTool({
    name: 'control_run',
    arguments: { run_type: 'http', run_id: bogusRunId, action: 'rerun', mode: 'stale' },
  }) as { isError?: boolean }
  expect(unknown.isError).toBe(true)

  // HTTP keeps its historical default (no mode = every row) — unchanged, since
  // the money-risk asymmetry is AI-specific (HTTP hits the user's own API).
  const noMode = await client.callTool({
    name: 'control_run',
    arguments: { run_type: 'http', run_id: bogusRunId, action: 'rerun' },
  })
  expect(isError(noMode)).toBe(true)
  expect(errorText(noMode).toLowerCase()).toContain('not found')

  await client.close()
})

test('v1 AI rerun validates mode and keeps its back-compat default', async () => {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'rerun-modes-v1')
  const bogusRunId = '00000000-0000-4000-8000-000000000000'

  // Unknown mode → 400 naming the valid set (validation before the run lookup).
  const bad = await api.post(`${BASE}/api/v1/ai-runs/${bogusRunId}/rerun`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { mode: 'everything' },
  })
  expect(bad.status()).toBe(400)
  expect((await bad.json()).error).toContain('errored')

  // Omitted mode (and no row_ids) → 400 on v1 too, as on MCP: a default of
  // 'missing' re-billed every empty row. Checked before the run lookup.
  const omitted = await api.post(`${BASE}/api/v1/ai-runs/${bogusRunId}/rerun`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {},
  })
  expect(omitted.status()).toBe(400)
  expect((await omitted.json()).error).toContain('mode')
})

test('an AI rerun takes a new concurrency; other runs refuse it', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'rerun-concurrency')
  const client = await mcpClient(token)
  const call = async (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<any>
  const settle = async (runId: string) => {
    for (let i = 0; i < 80; i++) {
      const s = parseResult(await call('get_run_status', { run_type: 'ai', run_id: runId }))
      if (['completed', 'failed', 'cancelled'].includes(s?.status)) return s
      await new Promise(r => setTimeout(r, 250))
    }
    throw new Error(`run ${runId} did not settle`)
  }
  // A stopped run frees its column a moment after its last placeholder is cleared.
  const rerun = async (runId: string, how: Record<string, unknown>) => {
    for (let i = 0; i < 20; i++) {
      const r = await call('control_run', { run_type: 'ai', run_id: runId, action: 'rerun', ...how })
      if (!(r.isError && errorText(r).includes('still clearing'))) return r
      await new Promise(res => setTimeout(res, 250))
    }
    throw new Error('column stayed busy')
  }

  const started = parseResult(await call('run_ai_column', {
    sheet_id: sheetId, column_name: 'Note', prompt: 'Say /val', model: 'openai/gpt-4o-mini', concurrency: 2,
  }))
  expect((await settle(started.run_id)).concurrency).toBe(2)

  // Out of range: refused before anything runs.
  for (const concurrency of [0, 101]) {
    const bad = await call('control_run', {
      run_type: 'ai', run_id: started.run_id, action: 'rerun', mode: 'all', concurrency,
    })
    expect(isError(bad)).toBe(true)
  }
  const lower = parseResult(await rerun(started.run_id, { mode: 'all', concurrency: 1 }))
  expect((await settle(lower.run_id)).concurrency).toBe(1)
  // Without one, the rerun keeps the run it repeats.
  const kept = parseResult(await rerun(lower.run_id, { mode: 'all' }))
  expect((await settle(kept.run_id)).concurrency).toBe(1)

  // Only an AI or enrichment rerun takes it.
  const paused = await call('control_run', { run_type: 'ai', run_id: kept.run_id, action: 'pause', concurrency: 3 })
  expect(errorText(paused)).toContain('applies only to rerunning an AI or enrichment run')
  const http = await call('control_run', {
    run_type: 'http', run_id: '00000000-0000-4000-8000-000000000000', action: 'rerun', concurrency: 3,
  })
  expect(errorText(http)).toContain('applies only to rerunning an AI or enrichment run')

  // v1: a number, from 1 to 100.
  const v1 = async (data: Record<string, unknown>) => {
    for (let i = 0; i < 20; i++) {
      const r = await api.post(`${BASE}/api/v1/ai-runs/${kept.run_id}/rerun`, {
        headers: { Authorization: `Bearer ${token}` }, data,
      })
      if (r.status() !== 409) return r
      await new Promise(res => setTimeout(res, 250))
    }
    throw new Error('column stayed busy')
  }
  expect((await v1({ mode: 'all', concurrency: 'fast' })).status()).toBe(400)
  const over = await v1({ mode: 'all', concurrency: 500 })
  expect(over.status()).toBe(400)
  expect((await over.json()).error).toContain('1 to 100')
  const viaV1 = await v1({ mode: 'all', concurrency: 4 })
  expect(viaV1.status()).toBe(202)
  expect((await settle((await viaV1.json()).run_id)).concurrency).toBe(4)
  await client.close()
})
