import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, makeAccessToken } from './helpers'
import { BAD_URL, GOOD_URL, mcpClient, parseResult, pollTerminal } from './helpers-run-results'

// get_run_results — per-row run diagnosis.
// The scenario: a run finishes with SOME rows failed. Aggregate status can't say
// why, so the agent's only recovery was a blind, paid rerun of everything. This
// tool returns per-row status + error_message + an actionable error_class, so
// the agent can diagnose and then rerun only the transient failures.
//
// The load-bearing assertion is that status_filter filters IN SQL: a filtered
// page must contain ONLY matching rows, and its cursor must not imply unseen
// data that isn't there. Tenancy/scope live in mcp-run-results-authz.spec.ts.


test('get_run_results surfaces per-row failures and filters in SQL', async () => {
  test.setTimeout(150_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 3)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'run-results')
  const client = await mcpClient(token)

  // Every row 404s → three failed rows, the diagnostic case.
  const started = parseResult(await client.callTool({
    name: 'run_http_enrichment',
    arguments: {
      sheet_id: sheetId,
      url: BAD_URL,
      method: 'GET',
      response_mapping: [{ json_path: '$.title', column_name: 'Title' }],
      master_column_name: 'Lookup',
    },
  }))
  expect(started.run_id).toBeTruthy()
  const done = await pollTerminal(client, started.run_id)
  expect(done.status).toBe('completed')

  // DEFAULT is 'failed' — the whole point. No status_filter passed.
  const failed = parseResult(await client.callTool({
    name: 'get_run_results', arguments: { run_type: 'http', run_id: started.run_id },
  }))
  expect(failed.status_filter).toBe('failed')
  expect(failed.results.length).toBe(3)
  // Every returned row is genuinely a failure, and carries a REASON — the thing
  // get_run_status could not tell you.
  for (const r of failed.results) {
    expect(r.status).toBe('failed')
    expect(typeof r.error_message).toBe('string')
    expect(r.error_message.length).toBeGreaterThan(0)
    expect(typeof r.row_id).toBe('string')  // stable id → feeds rerun row_ids
  }

  // Every failure carries an error_class + the page carries an error_summary,
  // so a caller knows what to DO without parsing message text itself. An
  // upstream 404 is HTTP's own class (it used to come back "unknown").
  for (const r of failed.results) expect(r.error_class).toBe('not_found')
  expect(Array.isArray(failed.error_summary)).toBe(true)
  expect(failed.error_summary.length).toBeGreaterThan(0)
  // Counts must add up to the failures on the page — a summary that quietly
  // drops rows is worse than no summary.
  const summed = failed.error_summary.reduce((n: number, s: any) => n + s.count, 0)
  expect(summed).toBe(failed.results.length)
  for (const s of failed.error_summary) expect(typeof s.hint).toBe('string')

  // 'completed' on an all-failed run returns NOTHING — and, critically, a null
  // cursor. If the filter were applied after paging we'd get an empty array
  // with a live cursor, and a paging caller would loop forever.
  const okOnly = parseResult(await client.callTool({
    name: 'get_run_results',
    arguments: { run_type: 'http', run_id: started.run_id, status_filter: 'completed' },
  }))
  expect(okOnly.results).toHaveLength(0)
  expect(okOnly.next_cursor).toBeNull()

  // 'all' sees every row.
  const all = parseResult(await client.callTool({
    name: 'get_run_results',
    arguments: { run_type: 'http', run_id: started.run_id, status_filter: 'all' },
  }))
  expect(all.results.length).toBe(3)

  await client.close()
})

test('get_run_results pages, and only returns matching rows on a mixed run', async () => {
  test.setTimeout(150_000)
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, 2)
  const token = await makeAccessToken(api, ['read', 'write', 'run'], 'run-results-mixed')
  const client = await mcpClient(token)

  // A run where every row SUCCEEDS, so 'failed' must come back empty while
  // 'completed' returns everything — the inverse of the first test, proving the
  // filter tracks real status rather than always returning the page.
  const started = parseResult(await client.callTool({
    name: 'run_http_enrichment',
    arguments: {
      sheet_id: sheetId,
      url: GOOD_URL,
      method: 'GET',
      response_mapping: [{ json_path: '$.title', column_name: 'Title' }],
      master_column_name: 'Lookup',
    },
  }))
  await pollTerminal(client, started.run_id)

  const failed = parseResult(await client.callTool({
    name: 'get_run_results', arguments: { run_type: 'http', run_id: started.run_id },
  }))
  expect(failed.results).toHaveLength(0)
  expect(failed.next_cursor).toBeNull()
  // No failures on the page → no error_summary at all, rather than an empty
  // array a caller would have to special-case.
  expect(failed.error_summary).toBeUndefined()

  const okOnly = parseResult(await client.callTool({
    name: 'get_run_results',
    arguments: { run_type: 'http', run_id: started.run_id, status_filter: 'completed' },
  }))
  expect(okOnly.results.length).toBe(2)
  for (const r of okOnly.results) expect(r.status).toBe('completed')

  // limit:1 → a cursor, and following it yields the NEXT row (not a repeat).
  const page1 = parseResult(await client.callTool({
    name: 'get_run_results',
    arguments: { run_type: 'http', run_id: started.run_id, status_filter: 'all', limit: 1 },
  }))
  expect(page1.results).toHaveLength(1)
  expect(page1.next_cursor).not.toBeNull()
  const page2 = parseResult(await client.callTool({
    name: 'get_run_results',
    arguments: {
      run_type: 'http', run_id: started.run_id, status_filter: 'all',
      limit: 1, cursor: page1.next_cursor,
    },
  }))
  expect(page2.results).toHaveLength(1)
  expect(page2.results[0].row_index).toBeGreaterThan(page1.results[0].row_index)

  await client.close()
})
