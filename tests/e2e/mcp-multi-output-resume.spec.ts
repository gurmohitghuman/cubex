import { test, expect } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authedApi, seedSheet, BASE, makeAccessToken } from './helpers'

// Slice B, pause/resume: the gap the round-trip smoke does NOT cover.
//
// A structured run anchors its lifecycle on the STATUS column (ai_runs.column_name
// = "<base> (Status)"), and the resume filter in ai-runner.ts is placeholder-driven:
// it reprocesses exactly the rows still holding '⏳ Processing...' in that column.
// The failure this guards against is a row whose in-flight call was aborted by the
// pause sitting on ⏳ forever with no retry path — and its mirror, a COMPLETED row
// being reprocessed (re-billed) on resume.
//
// Needs a live key: the pause has to interrupt real in-flight work.

const SMOKE_KEY = process.env.CUBEX_SMOKE_OPENROUTER_KEY
const SMOKE_MODEL = process.env.CUBEX_SMOKE_MODEL || 'deepseek/deepseek-v4-flash'
const ROWS = 12

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'e2e-multi-resume', version: '1.0.0' })
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

const OUTPUT_COLUMNS = [
  { column_name: 'Fit Score', type: 'number', description: 'Integer 1-10 fit rating' },
  { column_name: 'Fit Reason', type: 'string', description: 'One short sentence why' },
]

const COMPANIES = [
  'Stripe — online payment processing APIs for internet businesses',
  'Notion — all-in-one workspace for notes, docs, and collaboration',
  'Datadog — cloud infrastructure monitoring and observability',
  'Figma — collaborative interface design in the browser',
  'Snowflake — cloud data warehouse for analytics workloads',
  'Zendesk — customer support ticketing and helpdesk software',
  'Twilio — programmable messaging and voice APIs',
  'Segment — customer data platform and event pipelines',
  'Airtable — spreadsheet-database hybrid for business workflows',
  'Asana — team project and task management software',
  'Okta — enterprise identity and single sign-on',
  'Gusto — small-business payroll and benefits administration',
]

test('multi-output: pause mid-run then resume leaves no cell on ⏳', async () => {
  test.skip(!SMOKE_KEY, 'set CUBEX_SMOKE_OPENROUTER_KEY to run the live resume smoke')
  test.setTimeout(180_000)
  const api = await authedApi()
  const put = await api.put('/api/settings/openrouter-key', { data: { apiKey: SMOKE_KEY } })
  expect(put.ok()).toBeTruthy()
  // The key lands on the SHARED seed user and would outlive this test — a later
  // spec asserting "no key configured" would then see one. Always clear it.
  const clearKey = async () => { await api.delete('/api/settings/openrouter-key') }

  const { sheetId } = await seedSheet(api, ROWS)
  await api.put(`/api/sheets/${sheetId}/data`, {
    data: { updates: COMPANIES.map((value, rowIndex) => ({ rowIndex, columnName: 'val', value })) },
  })

  const client = await mcpClient(await makeAccessToken(api, ['read', 'write', 'run'], 'e2e multi resume'))

  const started = parseResult(await client.callTool({
    name: 'run_ai_column',
    arguments: {
      sheet_id: sheetId, column_name: 'Lead', model: SMOKE_MODEL,
      prompt: 'Score this company as a B2B SaaS lead: /val. Give a fit score 1-10 and a one-sentence reason.',
      output_columns: OUTPUT_COLUMNS,
    },
  }))
  const runId = started.run_id
  expect(started.status_column).toBe('Lead (Status)')

  // Pause as soon as the run has real progress but is NOT finished — that's the
  // window where an in-flight row can be aborted mid-call.
  let paused = false
  for (let i = 0; i < 60; i++) {
    const s = parseResult(await client.callTool({
      name: 'get_run_status', arguments: { run_type: 'ai', run_id: runId },
    }))
    if (['completed', 'failed', 'cancelled'].includes(s?.status)) break
    if ((s?.processed_rows ?? 0) >= 1) {
      const res = parseResult(await client.callTool({
        name: 'control_run', arguments: { run_type: 'ai', run_id: runId, action: 'pause' },
      }))
      paused = res?.status === 'paused'
      break
    }
    await new Promise(r => setTimeout(r, 250))
  }
  console.log(`[RESUME-EVIDENCE] pause landed: ${paused}`)
  test.skip(!paused, 'run finished before a pause could land — rerun with more rows')

  // Snapshot the paused state: which rows were already done, and what they hold.
  // Those cells must be byte-identical after the resume (never reprocessed).
  const midRows = parseResult(await client.callTool({ name: 'read_rows', arguments: { sheet_id: sheetId } })).rows
  const doneAtPause = new Map<string, { score: string; reason: string }>()
  for (const r of midRows) {
    if (r.data['Lead (Status)'] === '✅') {
      doneAtPause.set(r.id, { score: String(r.data['Fit Score']), reason: String(r.data['Fit Reason']) })
    }
  }
  const pendingAtPause = midRows.filter((r: any) => String(r.data['Lead (Status)'] ?? '').includes('⏳')).length
  console.log(`[RESUME-EVIDENCE] at pause: ${doneAtPause.size} done, ${pendingAtPause} still on placeholder (of ${ROWS})`)
  expect(doneAtPause.size).toBeGreaterThan(0)
  expect(doneAtPause.size).toBeLessThan(ROWS)

  const resumed = parseResult(await client.callTool({
    name: 'control_run', arguments: { run_type: 'ai', run_id: runId, action: 'resume' },
  }))
  expect(['running', 'pending']).toContain(resumed.status)

  let status: any = null
  for (let i = 0; i < 150; i++) {
    status = parseResult(await client.callTool({
      name: 'get_run_status', arguments: { run_type: 'ai', run_id: runId },
    }))
    if (['completed', 'failed', 'cancelled'].includes(status?.status)) break
    await new Promise(r => setTimeout(r, 1000))
  }
  expect(status.status).toBe('completed')

  // THE assertion: every row terminal, nothing stranded on the placeholder in
  // ANY of the run's columns (status + both typed outputs).
  const finalRows = parseResult(await client.callTool({ name: 'read_rows', arguments: { sheet_id: sheetId } })).rows
  expect(finalRows.length).toBe(ROWS)
  for (const row of finalRows) {
    const cells = ['Lead (Status)', 'Fit Score', 'Fit Reason'].map(c => String(row.data[c] ?? ''))
    for (const cell of cells) expect(cell).not.toContain('⏳')
    expect(row.data['Lead (Status)']).toBe('✅')
    expect(String(row.data['Fit Score'])).toMatch(/^\d+(\.\d+)?$/)
    expect(String(row.data['Fit Reason']).length).toBeGreaterThan(0)
  }

  // Rows completed BEFORE the pause keep their original values — a resume that
  // reprocessed them would re-bill the user and (with a nonzero temperature)
  // almost certainly write a different reason string.
  for (const row of finalRows) {
    const before = doneAtPause.get(row.id)
    if (!before) continue
    expect(String(row.data['Fit Score'])).toBe(before.score)
    expect(String(row.data['Fit Reason'])).toBe(before.reason)
  }

  console.log(`[RESUME-EVIDENCE] after resume: all ${finalRows.length} rows terminal, ${doneAtPause.size} pre-pause rows unchanged`)
  await client.close()
  await clearKey()
})
