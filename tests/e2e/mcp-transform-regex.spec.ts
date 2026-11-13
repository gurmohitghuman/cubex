import { test, expect } from '@playwright/test'
import { authedApi, seedSheet, makeAccessToken } from './helpers'
import { mcpClient, call, callError } from './helpers-mcp'

// transform_column's regex_extract runs on a worker of its own, a page of cells at a time. A pattern slow on long
// cells, not stuck, is written over as many calls as it needs; one whose first row's cell alone takes more than 1
// second is refused, naming the row, with no cell written. While the calls run, the server answers other requests
// (within 250 ms here: this probe's own time varies by 20 to 30 ms; the event loop itself is measured in
// tests/unit/transform-regex-pages.test.ts).
const ROWS = 250
const long = (n: number, i: number) => `${'x'.repeat(n - 10)}${String(i).padStart(10, 'y')}`

// A sheet of ROWS rows whose column S holds cell(i), and an MCP client for it.
async function sheetOf(cell: (i: number) => string) {
  const api = await authedApi()
  const { sheetId } = await seedSheet(api, ROWS)
  await api.post(`/api/sheets/${sheetId}/columns`, { data: { columnName: 'S' } })
  const updates = Array.from({ length: ROWS }, (_, i) => ({ rowIndex: i, columnName: 'S', value: cell(i) }))
  expect((await api.put(`/api/sheets/${sheetId}/data`, { data: { updates } })).ok()).toBe(true)
  const client = await mcpClient(await makeAccessToken(api, ['read', 'write'], 'e2e transform regex'))
  const args = (pattern: string, target: string, cursor?: string) => ({ sheet_id: sheetId, source_column: 'S',
    target_column: target, operation: 'regex_extract', pattern, ...(cursor ? { cursor } : {}) })
  const rows = (more: Record<string, unknown> = {}) => call(client, 'read_rows', { sheet_id: sheetId, ...more })
  return { api, client, args, rows }
}

// `fn`'s answer, and the slowest of the GET /api/tables asked every 25 ms while it ran.
async function probed<T>(api: Awaited<ReturnType<typeof authedApi>>, fn: () => Promise<T>) {
  let probing = true
  let slowest = 0
  const probe = (async () => {
    while (probing) {
      const t = Date.now()
      expect((await api.get('/api/tables')).ok()).toBe(true)
      slowest = Math.max(slowest, Date.now() - t)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  })()
  try { return { out: await fn(), slowest } } finally { probing = false; await probe }
}

for (const [label, size, pattern, found] of [
  ['(.*)@ on 3,000-character cells', 3_000, '(.*)@', 'name'],
  ['(.*)@ on 10,000-character cells', 10_000, '(.*)@', 'name'],
  ['(\\S+@\\S+) on 2,000-character cells', 2_000, '(\\S+@\\S+)', 'name@example.com'],
] as const) {
  test(`transform_column: ${label} with no match is slow, not stuck: written, the server answering`, async () => {
    test.setTimeout(180_000)
    const { api, client, args, rows } = await sheetOf(i => (i === ROWS - 1 ? 'name@example.com' : long(size, i)))
    const { out: [updated, calls], slowest } = await probed(api, async () => {
      let done = 0
      let n = 0
      for (let cursor: string | undefined, more = true; more; n++) {
        const out = await call(client, 'transform_column', args(pattern, 'Out', cursor))
        done += out.updated
        cursor = out.next_cursor
        more = cursor !== undefined
      }
      return [done, n]
    })
    console.log(`${label}: ${updated} rows in ${calls} calls; GET /api/tables took at most ${slowest} ms`)
    expect(updated).toBe(ROWS)
    const named = (await rows({ where: [{ column: 'S', operator: 'contains', value: '@' }] })).rows
    expect(named.map((r: any) => r.data.Out)).toEqual([found])
    expect(slowest).toBeLessThan(250)
    await client.close()
  })
}

test('transform_column: a first row whose cell stalls the pattern is refused, naming it, no cell written', async () => {
  test.setTimeout(120_000)
  const stalls = [[`${'a*'.repeat(12)}b`, 'a'], ['\\d+\\d+b', '1'], ['\\d{0,200}\\d{0,200}\\d{0,200}b', '1']]
  for (const [pattern, letter] of stalls) {
    const { api, client, args, rows } = await sheetOf(i => (i === 0 ? letter.repeat(8000) : 'b'))
    const first = (await rows()).rows[0]
    const started = Date.now()
    const refuse = () => callError(client, 'transform_column', args(pattern, 'Stuck'))
    const { out: error, slowest } = await probed(api, refuse)
    console.log(`${pattern}: refused after ${Date.now() - started} ms; GET /api/tables took at most ${slowest} ms`)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(error).toContain('regex_extract stopped: the pattern took more than 1 second on the cell of row '
      + `${first.id}. No cell was written.`)
    expect((await rows({ where: [{ column: 'Stuck', operator: 'not_empty' }], return_mode: 'count' })).count).toBe(0)
    expect(slowest).toBeLessThan(250)
    await client.close()
  }
})
