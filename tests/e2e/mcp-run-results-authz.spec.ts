import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, makeAccessToken } from './helpers'
import { mcpClient, parseResult } from './helpers-run-results'

// Scope rules for get_run_results. Split from mcp-run-results.spec.ts (the
// 200-line guardrail): that file is about the RESULT SHAPE (filtering, paging,
// error classes); this one is about which tokens may read a run at all.

const ABSENT_RUN = '00000000-0000-4000-8000-000000000000'

test('get_run_results: run/write imply read, so those tokens may diagnose', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  await seedSheet(api, 1)

  // expandScopes (lib/access-token.ts) grants 'read' implicitly to 'write' and
  // 'run' tokens. That is deliberate and worth pinning: a token allowed to
  // START a run must be able to see WHY its rows failed, or it can only recover
  // by re-running blind — the exact failure get_run_results exists to prevent.
  // So a run-only token reaches the lookup and gets a normal not-found, NOT a
  // scope denial.
  const runOnly = await makeAccessToken(api, ['run'], 'run-results-noread')
  const client = await mcpClient(runOnly, 'e2e-run-results-scope')
  const res = parseResult(await client.callTool({
    name: 'get_run_results', arguments: { run_type: 'ai', run_id: ABSENT_RUN },
  }))
  expect(res.error).toContain('not found')
  expect(res.error).not.toContain('scope')

  await client.close()
})
