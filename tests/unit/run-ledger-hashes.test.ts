// A run start's ledger row holds the start's hashes (lib/run-idempotency.ts): its arguments as sent and as
// parsed, space separated, or one alone (a row written before the sent one was kept, or a start whose two are
// the same). A retry giving either hash of a pair replays, and so does one giving a pair whose parsed hash is
// a row's only one; the stored text as one string, a prefix of a hash, and an empty hash are other arguments.
import assert from 'node:assert/strict'
import { undoKit } from './run-undo-kit'
import ledgerMod from '../../server/src/lib/run-idempotency'
const { readRunLedger, runRequestHash, writeRunLedger } =
  ledgerMod as typeof import('../../server/src/lib/run-idempotency')
const { db, uid, ok, done } = undoKit('run-ledger-hashes')

const S = runRequestHash('http_run', { sent: { url: 'https://api.example.com/a' } })
const P = runRequestHash('http_run', { url: 'https://api.example.com/a', parsed: true })
const X = runRequestHash('http_run', { url: 'https://api.example.com/other' })
const stored = (key: string) => db.prepare(`SELECT request_hash FROM data_operation_ledger WHERE user_id = ?
  AND idempotency_key = ?`).pluck().get(uid, key)
const replay = { replay: { run_id: 'run-1' } }
const conflict = { conflict: true }

await ok('a pair is stored as both hashes, space separated; one hash (or two the same) is stored alone', () => {
  writeRunLedger(uid, 'pair', [S, P], 'http_run', { run_id: 'run-1' })
  writeRunLedger(uid, 'one', P, 'http_run', { run_id: 'run-1' })
  writeRunLedger(uid, 'same', [P, P], 'http_run', { run_id: 'run-1' })
  assert.equal(stored('pair'), `${S} ${P}`)
  assert.equal(stored('one'), P)
  assert.equal(stored('same'), P)
})

await ok('either hash of a pair replays, as does a pair holding the only hash of a row written before', () => {
  for (const given of [S, P, [S], [P], [X, P], [S, X]]) {
    assert.deepEqual(readRunLedger(uid, 'pair', given), replay, JSON.stringify(given))
  }
  assert.deepEqual(readRunLedger(uid, 'one', [S, P]), replay, 'a row from before: its parsed hash')
  assert.deepEqual(readRunLedger(uid, 'one', P), replay)
  assert.deepEqual(readRunLedger(uid, 'one', S), conflict, 'the sent hash alone is not the row\'s')
})

await ok('the stored text as one hash, a prefix of a hash, an empty hash and another hash are other arguments', () => {
  for (const given of [`${S} ${P}`, [`${S} ${P}`], S.slice(0, 32), P.slice(0, 63), `${S} `, '', [''], [], X, [X]]) {
    assert.deepEqual(readRunLedger(uid, 'pair', given), conflict, JSON.stringify(given))
  }
  for (const given of [P.slice(0, 32), '', [''], ` ${P}`]) {
    assert.deepEqual(readRunLedger(uid, 'one', given), conflict, JSON.stringify(given))
  }
  assert.equal(readRunLedger(uid, 'never-used', [S, P]), null, 'a key never used: the start goes ahead')
})

done()
