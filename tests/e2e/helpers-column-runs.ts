import { expect } from '@playwright/test'
import type { authedApi } from './helpers'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { call } from './helpers-mcp'
import type { Receiver } from './helpers-receiver'
import { sheetWith, column } from './helpers-setups'

// Shared by the column run specs: a sheet of three websites with two HTTP API columns on the spec's
// receiver: Lookup (a site's short name into Short) and Echo, which reads the formula Label = Short + "!".
// short(suffix): what Lookup's answers say from now on ('' at first: "one", "two", "three").
export const SITES = ['one', 'two', 'three']
export const short = (rx: Receiver, suffix: string) => SITES.forEach(s =>
  rx.on(`/short/${s}.com`, { status: 200, body: JSON.stringify({ short: `${s}${suffix}` }) }))

type Api = Awaited<ReturnType<typeof authedApi>>
export async function twoColumns(rx: Receiver, client: Client, api: Api) {
  const { tableId, sheetId } = await sheetWith(api, null, SITES.map(s => ({ Website: `${s}.com` })))
  short(rx, '')
  const httpDone = async (runId: string) => expect.poll(async () =>
    (await call(client, 'get_run_status', { run_type: 'http', run_id: runId })).status, { timeout: 30_000 })
    .toBe('completed')
  const lookup = await call(client, 'run_http_enrichment', { sheet_id: sheetId, url: rx.url('/short/{{Website}}'),
    method: 'POST', master_column_name: 'Lookup', response_mapping: [{ json_path: '$.short', column_name: 'Short' }] })
  await httpDone(lookup.run_id)
  await call(client, 'formula_column', { sheet_id: sheetId, column: 'Label', formula: '{{Short}} + "!"' })
  await expect.poll(() => column(api, sheetId, 'Label'), { timeout: 15_000 }).toEqual(['one!', 'two!', 'three!'])
  for (const s of SITES) for (const v of ['!', '2!']) rx.on(`/echo/${s}${v}`, { status: 200, body: '{"ok":"yes"}' })
  const echo = await call(client, 'run_http_enrichment', { sheet_id: sheetId, url: rx.url('/echo/{{Label}}'),
    method: 'POST', master_column_name: 'Echo', response_mapping: [{ json_path: '$.ok', column_name: 'Echo ok' }] })
  await httpDone(echo.run_id)
  return { tableId, sheetId }
}
