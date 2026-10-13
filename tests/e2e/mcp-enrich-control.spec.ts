import { test, expect } from '@playwright/test'
import { authedApi, makeAccessToken } from './helpers'
import { expectBilledOnce, freshTreg, rowsOf, runIdsOf, seedLeadRows } from './helpers-enrich'
import { call, callError, mcpClient, waitMcpRun } from './helpers-mcp'

// Controlling an enrichment run through MCP (plan Features H): a pause by its
// run limit says why and carries daily_limit, control_run resume raises the
// limit, a rerun goes through the column's own setup with its modes, and
// spend_limit_usd is refused where it means nothing.

const LEADS = Array.from({ length: 6 }, (_, i) => ({ Name: `Lead Person${i}`, Website: `co${i}.example` }))
const FIND = {
  tool_id: 'treg.people.email.find', column_name: 'Find email', inputs: { full_name: 'Name', domain: 'Website' },
  outputs: [{ field: 'email', column_name: 'Email' }, { field: 'found_by', column_name: 'Found by' }],
}

test('the run limit pauses; resume raises it; reruns take the column\'s setup', async () => {
  test.setTimeout(90_000)
  const api = await authedApi()
  await freshTreg(api)
  const { sheetId } = await seedLeadRows(api, LEADS)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e mcp control'))
  const started = await call(client, 'run_enrichment', {
    sheet_id: sheetId, ...FIND, max_cost_per_row_usd: 0.01, spend_limit_usd: 0.02, concurrency: 7,
  })
  expect(started.spend_limit_usd).toBe(0.02)
  const paused = await waitMcpRun(client, started.run_id, ['paused'])
  expect(paused.enrichment.concurrency).toBe(7)
  expect(paused.enrichment.pause_reason).toBe('spend_limit')
  expect(paused.error_message).toContain('$0.02 spend limit')
  expect(paused.daily_limit.limit_usd).toBe(10)
  expect(paused.cost_usd).toBeLessThanOrEqual(0.02)

  // spend_limit_usd means nothing on a pause, or on an AI run.
  expect(await callError(client, 'control_run', {
    run_type: 'enrichment', run_id: started.run_id, action: 'pause', spend_limit_usd: 1,
  })).toContain('spend_limit_usd')
  const resumed = await call(client, 'control_run', {
    run_type: 'enrichment', run_id: started.run_id, action: 'resume', spend_limit_usd: 1,
  })
  expect(resumed.enrichment.spend_limit_usd).toBe(1)
  const done = await waitMcpRun(client, started.run_id, ['completed'])
  expect(done.enrichment.pause_reason).toBeNull()
  expect((await rowsOf(api, sheetId)).filter(r => r['Find email'] === '✅ Found')).toHaveLength(6)

  // Reruns: a mode is required; "errored" with nothing failed is refused; "all" buys every row again.
  expect(await callError(client, 'control_run', { run_type: 'enrichment', run_id: started.run_id, action: 'rerun' }))
    .toContain('row_ids or mode')
  expect(await callError(client, 'control_run', {
    run_type: 'enrichment', run_id: started.run_id, action: 'rerun', mode: 'errored',
  })).toContain('No rows here failed')
  const ids = (await call(client, 'read_rows', { sheet_id: sheetId, limit: 2 })).rows.map((r: any) => r.id)
  const again = await call(client, 'control_run', {
    run_type: 'enrichment', run_id: started.run_id, action: 'rerun', row_ids: ids, spend_limit_usd: 0.5,
  })
  expect(again.run_type).toBe('enrichment')
  expect(again.rows_in_scope).toBe(2)
  const second = await waitMcpRun(client, again.run_id, ['completed'])
  expect(second.total_rows).toBe(2)
  expect(second.enrichment.spend_limit_usd).toBe(0.5)
  expect(second.enrichment.concurrency).toBe(7)
  // The first run is superseded now: its id names the latest.
  expect(await callError(client, 'control_run', {
    run_type: 'enrichment', run_id: started.run_id, action: 'rerun', mode: 'all',
  })).toContain(again.run_id)
  // A rerun's run limit has the same bounds as a start's.
  expect(await callError(client, 'control_run', {
    run_type: 'enrichment', run_id: again.run_id, action: 'rerun', mode: 'all', spend_limit_usd: 1e12,
  })).toContain('The run limit must be more than $0 and at most')
  // A rerun can set its rows at once; over 100 the tool's schema refuses it (plain text, not a JSON error).
  const tooMany = await client.callTool({
    name: 'run_enrichment', arguments: { sheet_id: sheetId, ...FIND, concurrency: 101 },
  })
  expect(tooMany.isError).toBe(true)
  expect(JSON.stringify(tooMany.content)).toContain('concurrency')
  const slower = await call(client, 'control_run', {
    run_type: 'enrichment', run_id: again.run_id, action: 'rerun', row_ids: ids, concurrency: 1,
  })
  expect((await waitMcpRun(client, slower.run_id, ['completed'])).enrichment.concurrency).toBe(1)
  // run_type enrichment refuses a run that isn't one.
  expect(await callError(client, 'get_run_status', { run_type: 'enrichment', run_id: 'no-such-run' }))
    .toContain('Enrichment run not found')
  await expectBilledOnce(runIdsOf(sheetId))
  await api.dispose()
})
