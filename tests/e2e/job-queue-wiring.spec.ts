import { test, expect, APIRequestContext } from '@playwright/test'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { authedApi, seedSheet, importCsv, assertTestDb } from './helpers'
import { bearer, makeToken, waitForTerminal } from './api-v1-run-helpers'
import { Receiver } from './helpers-receiver'

// The job queue's wiring on the built server, which no unit test sees: at start (queue.ts startQueue) jobs.db is
// switched to WAL (lib/jobs-db.ts), and a run's job goes in through the insert worker (lib/job-inserts.ts), which
// is built next to it in server/dist. Either one broken still works, only slower (the queue in its old journal
// mode; inserts on the server's thread after one "insert worker" log line), so nothing else fails.
const rx = new Receiver()
let api: APIRequestContext
let v1: APIRequestContext

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await rx.start()
  api = await authedApi()
  v1 = await bearer(await makeToken(api, ['read', 'write', 'run'], 'job queue wiring spec'))
})
test.afterAll(async () => { await rx.stop(); await v1?.dispose() })

function readJobsDb<T>(read: (db: Database.Database) => T): T {
  const file = assertTestDb(process.env.JOBS_DB_PATH)
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try { return read(db) } finally { db.close() }
}
function serverLog(): string {
  const file = process.env.E2E_SERVER_LOG
  if (!file) throw new Error('E2E_SERVER_LOG not set: run via npm run e2e')
  return fs.readFileSync(file, 'utf8')
}

test('jobs.db is in WAL mode once the server has started', () => {
  expect(readJobsDb(db => db.pragma('journal_mode', { simple: true }))).toBe('wal')
})

test("a run's job goes in through the insert worker, which never falls back to the server's thread", async () => {
  // The log read is this server's: it says where its jobs.db is.
  expect(serverLog()).toContain(`Sidequest started (jobs.db: ${process.env.JOBS_DB_PATH}`)
  rx.on('/wiring', { status: 200, body: '{"ok":"yes"}' })
  const { sheetId } = await seedSheet(api, 1)
  expect((await importCsv(api, sheetId, 'Name\nAda\n', { replaceData: true })).ok()).toBeTruthy()
  const res = await v1.post(`/api/v1/sheets/${sheetId}/http-runs`, {
    data: { url: rx.url('/wiring'), response_mapping: [{ json_path: '$.ok', column_name: 'OK' }],
      master_column_name: 'Call' },
  })
  expect(res.status(), await res.text()).toBe(202)
  const runId = (await res.json()).run_id as string
  expect((await waitForTerminal(v1, `/api/v1/http-runs/${runId}`)).status).toBe('completed')
  const jobs = readJobsDb(db => db.prepare(`SELECT class, args FROM sidequest_jobs WHERE args LIKE ?`)
    .all(`%${runId}%`) as Array<{ class: string; args: string }>)
  expect(jobs.map(j => j.class)).toEqual(['HTTPRunJob'])
  expect(serverLog()).not.toMatch(/insert worker/)
})
