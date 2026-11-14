import path from 'node:path'
import { createRequire } from 'node:module'
import { test, expect } from '@playwright/test'
import { assertTestDb, authedApi, seedSheet } from './helpers'
import { JSON_URL, makeToken, bearer, httpConfig, waitForTerminal } from './api-v1-run-helpers'
import { mcpClient, call, callError } from './helpers-mcp'

// Row-write idempotency keys, at their edges (services/rows-write-keyed.ts,
// lib/write-idempotency.ts): a row-write key over a day old is free at once for
// a run start and for a transfer, whose retries then replay instead of running
// twice; and a replay answers after the sheet went to the trash, over REST and
// MCP, where a new key gets "Sheet not found".

const require = createRequire(import.meta.url)

// Makes a ledger entry over a day old, straight in the throwaway test DB.
function ageKey(key: string) {
  const Database = require(path.join(process.cwd(), 'node_modules/better-sqlite3'))
  const db = new Database(assertTestDb(process.env.DB_PATH))
  try {
    db.pragma('busy_timeout = 5000')
    const n = db.prepare(`UPDATE data_operation_ledger SET created_at = datetime('now', '-25 hours')
      WHERE idempotency_key = ?`).run(key).changes
    expect(n).toBe(1)
  } finally {
    db.close()
  }
}

test('a row-write key over a day old starts a run and a transfer at once; their retries replay', async () => {
  test.setTimeout(120_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 2)
  const v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'e2e expired write keys'))
  const append = (key: string) => v1.post(`/api/v1/sheets/${sheetId}/rows`, {
    data: { rows: [{ data: { val: key } }], idempotency_key: key },
  })

  // A run start with the key of an append a day ago: it starts, and its retry is the same run.
  expect((await append('e2e-exp-run')).status()).toBe(201)
  ageKey('e2e-exp-run')
  const start = () => v1.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { config: httpConfig(JSON_URL, 'Title'), master_column_name: 'Lookup', idempotency_key: 'e2e-exp-run' },
  })
  const started = await start()
  expect(started.status()).toBe(202)
  const runId = (await started.json()).run_id
  await waitForTerminal(v1, `/api/v1/http-runs/${runId}`)
  const retried = await start()
  expect(retried.ok()).toBeTruthy()
  expect(await retried.json()).toEqual(expect.objectContaining({ run_id: runId, replayed: true }))

  // A transfer with the key of an append a day ago: it copies, and its retry copies nothing more.
  const dest = await v1.post(`/api/v1/tables/${tableId}/sheets`, { data: { name: 'Dest' } })
  expect(dest.ok()).toBeTruthy()
  const destId = (await dest.json()).sheet.id
  expect((await append('e2e-exp-tr')).status()).toBe(201)
  ageKey('e2e-exp-tr')
  const transfer = () => v1.post(`/api/v1/sheets/${sheetId}/rows/transfer`, {
    data: { destination_sheet_id: destId, operation: 'copy', selection: { all: true } },
    headers: { 'Idempotency-Key': 'e2e-exp-tr' },
  })
  const moved = await transfer()
  const movedBody = await moved.json()
  expect(moved.status(), JSON.stringify(movedBody)).toBe(200)
  expect(movedBody.replayed).toBe(false)
  const again = await transfer()
  expect(again.status()).toBe(200)
  expect(await again.json()).toEqual(expect.objectContaining({ replayed: true, copied: movedBody.copied }))
  const destRows = await v1.get(`/api/v1/sheets/${destId}/rows?limit=500`)
  expect((await destRows.json()).rows).toHaveLength(movedBody.copied)
  await v1.dispose()
})

test('row-write replays answer after the sheet went to the trash, over REST and MCP', async () => {
  test.setTimeout(60_000)
  const api = await authedApi()
  const { tableId, sheetId } = await seedSheet(api, 1)
  const token = await makeToken(api, ['read', 'write'], 'e2e trashed replays')
  const v1 = await bearer(token)
  const mcp = await mcpClient(token, 'e2e-trashed-replays')
  const rowsBody = { rows: [{ data: { val: 'a' } }], idempotency_key: 'e2e-tr-ap' }
  const appended = await (await v1.post(`/api/v1/sheets/${sheetId}/rows`, { data: rowsBody })).json()
  const rowId = appended.rows[0].id
  const patchBody = { data: { val: 'b' }, idempotency_key: 'e2e-tr-up' }
  const patched = await (await v1.patch(`/api/v1/rows/${rowId}`, { data: patchBody })).json()
  const updates = [{ row_id: rowId, data: { val: 'c' } }]
  const updateBody = { updates, idempotency_key: 'e2e-tr-bt' }
  expect(await (await v1.post(`/api/v1/sheets/${sheetId}/rows/update`, { data: updateBody })).json())
    .toEqual({ updated: 1, replayed: false })

  expect((await v1.delete(`/api/v1/tables/${tableId}`)).ok()).toBeTruthy()

  const ap = await v1.post(`/api/v1/sheets/${sheetId}/rows`, { data: rowsBody })
  expect(ap.status()).toBe(200)
  expect(await ap.json()).toEqual({ ...appended, replayed: true })
  const up = await v1.patch(`/api/v1/rows/${rowId}`, { data: patchBody })
  expect(await up.json()).toEqual({ ...patched, replayed: true })
  const bt = await v1.post(`/api/v1/sheets/${sheetId}/rows/update`, { data: updateBody })
  expect(bt.status()).toBe(200)
  expect(await bt.json()).toEqual({ updated: 1, replayed: true })
  // An MCP replay wrote nothing: its changed is [].
  expect(await call(mcp, 'append_rows', { sheet_id: sheetId, rows: [{ val: 'a' }], idempotency_key: 'e2e-tr-ap' }))
    .toEqual({ rows: appended.rows, replayed: true, changed: [] })
  expect(await call(mcp, 'update_cells', { sheet_id: sheetId, updates, idempotency_key: 'e2e-tr-bt' }))
    .toEqual({ updated: 1, replayed: true, changed: [] })

  // A new key there writes nothing: the sheet isn't found (MCP adds that it is in the trash, and how to restore it).
  const fresh = await v1.post(`/api/v1/sheets/${sheetId}/rows`, { data: { ...rowsBody, idempotency_key: 'e2e-tr-2' } })
  expect(fresh.status()).toBe(404)
  expect(await fresh.json()).toEqual({ error: 'Sheet not found' })
  expect(await callError(mcp, 'update_cells', { sheet_id: sheetId, updates, idempotency_key: 'e2e-tr-3' }))
    .toMatch(new RegExp('^Sheet not found\\. It is sheet "Sheet1" \\(table "[^"]+"\\), which is in the trash: '
      + 'restore_from_trash with trash_ids \\[\\d+\\] brings it back\\.$'))
  await mcp.close()
  await v1.dispose()
})
