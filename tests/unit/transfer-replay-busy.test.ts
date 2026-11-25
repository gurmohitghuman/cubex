// A row transfer retried with its idempotency key answers its first transfer first (services/rows-transfer.ts),
// as a keyed run start does since #109: while the source or the destination is busy (past both guards: REST's
// /sheets/:id check and MCP's), and without a transfer slot, so retries after a timeout never run into the
// per-minute limit or a busy sheet. Over the service, REST (the key in the Idempotency-Key header) and MCP, each
// answers the first transfer's result with replayed: true and copies nothing again. A new key, or the known key
// with other arguments, is refused as busy in the guards' words, on every surface, and records nothing; once the
// sheet is free, a known key with other arguments is the idempotency conflict, as before.
import assert from 'node:assert/strict'
import { undoKit } from './run-undo-kit'
import { busyKit, type Args } from './token-replay-busy-kit'

const k = undoKit('transfer-replay-busy')
const { db, uid, sheet, ok, done } = k
const { transferRows } = await import('../../server/src/services/rows-transfer')
const { withSheetBusy, busyMessage } = await import('../../server/src/lib/sheet-busy')
const { TRANSFER_STARTS_PER_MIN } = await import('../../server/src/lib/api-v1-constants')
const { default: v1Transfer } = await import('../../server/src/routes/api-v1-transfer')
const kit = await busyKit(uid, [v1Transfer])

const src = sheet([{ Name: 'ada' }, { Name: 'bob' }], ['Name'])
const dest = sheet([], ['Name'])
const rowsIn = (sid: string) => db.prepare('SELECT COUNT(*) FROM rows WHERE sheet_id = ?').pluck().get(sid) as number
const keys = () => db.prepare('SELECT COUNT(*) FROM data_operation_ledger WHERE user_id = ?').pluck().get(uid) as number
const busy = busyMessage('sorting')

// One transfer of src's rows into dest, by key, over the service, REST or MCP.
const request = (key: string, operation: 'copy' | 'move' = 'copy') => ({
  sourceSheetId: src, destinationSheetId: dest, operation, selection: { all: true } as const,
  columnMode: 'create_missing' as const, columnModeOmitted: true, columnMapping: {}, idempotencyKey: key,
})
const service = (key: string, operation?: 'copy' | 'move') => transferRows(uid, request(key, operation))
const rest = (key: string, operation = 'copy') => kit.rest('/rows/transfer',
  { sheet_id: src, destination_sheet_id: dest, operation, selection: { all: true } } as Args, key)
const mcp = (key: string, operation = 'copy') => kit.tool('transfer_rows', { source_sheet_id: src,
  destination_sheet_id: dest, operation, selection: { all: true }, idempotency_key: key })

// Holds sheetId busy (a sort) while fn runs.
async function whileBusy(sheetId: string, fn: () => Promise<void>) {
  let release = () => {}
  const held = withSheetBusy(sheetId, 'sorting', () => new Promise<void>(r => { release = r }))
  try { await fn() } finally { release(); await held }
}

const first = service('t-1')
assert.ok('ok' in first && !first.replayed, JSON.stringify(first))
const copied = first.ok

await ok('the first transfer copies the rows', () => {
  assert.equal(copied.copied, 2)
  assert.equal(rowsIn(dest), 2)
})

for (const [which, sid] of [['source', src], ['destination', dest]] as const) {
  await ok(`retried with its key while the ${which} is busy: every surface answers the first transfer`, async () => {
    await whileBusy(sid, async () => {
      const viaService = service('t-1')
      assert.ok('ok' in viaService, JSON.stringify(viaService))
      assert.deepEqual([viaService.ok, viaService.replayed], [copied, true])
      const viaRest = await rest('t-1')
      assert.equal(viaRest.status, 200, JSON.stringify(viaRest.body))
      assert.deepEqual([viaRest.body.copied, viaRest.body.replayed], [2, true])
      const viaMcp = await mcp('t-1')
      assert.equal(viaMcp.isError, false, JSON.stringify(viaMcp.body))
      assert.deepEqual([viaMcp.body.copied, viaMcp.body.replayed], [2, true])
      assert.equal(rowsIn(dest), 2, 'nothing copied again')
    })
  })
}

await ok('a new key, or the known key with other arguments, is refused as busy on every surface', async () => {
  const before = keys()
  await whileBusy(src, async () => {
    for (const [key, operation] of [['t-new', 'copy'], ['t-1', 'move']] as const) {
      assert.deepEqual(service(key, operation), { fail: 'busy', error: busy }, `service ${key} ${operation}`)
      assert.deepEqual(await rest(key, operation), { status: 409, body: { error: busy, busy: true } })
      assert.deepEqual(await mcp(key, operation), { isError: true, body: { error: busy } })
    }
  })
  assert.equal(rowsIn(dest), 2, 'nothing copied')
  assert.equal(keys(), before, 'no key recorded')
})

await ok(`retries take no transfer slot: ${TRANSFER_STARTS_PER_MIN + 1} of them, then a new transfer goes through`,
  async () => {
    for (let i = 0; i <= TRANSFER_STARTS_PER_MIN; i++) {
      const again = service('t-1')
      assert.ok('ok' in again && again.replayed, `retry ${i}: ${JSON.stringify(again)}`)
    }
    const next = service('t-2')
    assert.ok('ok' in next && !next.replayed && next.ok.copied === 2, JSON.stringify(next))
    assert.equal(rowsIn(dest), 4)
  })

await ok('with the sheets free, the known key with other arguments is the idempotency conflict, as before', () => {
  const other = service('t-1', 'move')
  assert.ok('fail' in other && other.fail === 'conflict', JSON.stringify(other))
  assert.equal(rowsIn(src), 2, 'nothing moved')
})

kit.close()
done()
