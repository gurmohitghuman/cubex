// rows.updated_at kept by the writers that start runs and need the job queue
// (rows-updated-at.test.ts has every other writer): an HTTP auto-run's start
// puts ⏳ in the rows it takes (services/autorun-start.ts), and an enrichment's
// seeding puts ⏳ in the rows it runs and "⏭️ Condition not met" in the rows
// its "Only run if" keeps out (services/enrich-seed-run.ts). Sidequest's
// enqueue is stubbed (no worker runs), so the rows keep what the start wrote.
// Rows each start leaves alone keep their time.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { v4 as uuid } from 'uuid'
import { undoKit } from './run-undo-kit'

// The one Sidequest the server's queue.ts holds (its CommonJS build), so its enqueue only records.
const queued: unknown[][] = []
const { Sidequest } = createRequire(path.resolve('server/src/queue.ts'))('sidequest')
Sidequest.build = () => ({ enqueue: async (...args: unknown[]) => { queued.push(args); return {} } })

const { db, uid, ok, done, idle, sheet, cells } = undoKit('rows-updated-at-starts')
const { appendRows } = await import('../../server/src/services/rows-write')
const { saveAutorunSettings } = await import('../../server/src/services/autorun-settings')
const { autorunTick } = await import('../../server/src/services/autorun-loop')
const { seedEnrichmentThenEnqueue } = await import('../../server/src/services/enrich-seed-run')
const { asRunStart } = await import('../../server/src/services/run-seed')
const { normalizeTool } = await import('../../server/src/lib/enrich-tool')
const { requestToolOf } = await import('../../server/src/lib/enrich-run-config')

const PAST = '2000-01-01 00:00:00'
const past = (sid: string) => db.prepare('UPDATE rows SET updated_at = ? WHERE sheet_id = ?').run(PAST, sid)
const clock = () => db.prepare("SELECT datetime('now')").pluck().get() as string
// The rows (by index) whose time moved to `since` or later; every other row must still read PAST.
function changed(sid: string, since: string): number[] {
  const rows = db.prepare('SELECT row_index, updated_at FROM rows WHERE sheet_id = ? ORDER BY row_index')
    .all(sid) as Array<{ row_index: number; updated_at: string }>
  return rows.filter(r => {
    if (r.updated_at >= since) return true
    assert.equal(r.updated_at, PAST, `row ${r.row_index} reads ${r.updated_at}: neither now nor left alone`)
    return false
  }).map(r => r.row_index)
}

await ok("an HTTP auto-run's start: ⏳ in the new rows it takes", async () => {
  const sid = sheet([{ Email: 'old@a.example' }], ['Email', 'Push'])
  const config = { requestConfig: { method: 'POST', url: 'https://x.test/leads', headers: {},
    body: '{"email":"{{Email}}"}' }, responseMapping: [] }
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, allow_secrets)
    VALUES (?,?,?,?, 'completed', 'Push', 0)`).run(uuid(), sid, uid, JSON.stringify(config))
  const saved = await saveAutorunSettings(uid, sid,
    { column: 'Push', enabled: true, where: null, dailyCapUsd: null, dailyRowCap: null }, { hasSecretsScope: true })
  assert.ok('ok' in saved, JSON.stringify(saved))
  // Rows there before it was on are left alone; of the new ones, the row without its input waits.
  appendRows(sid, uid, [{ Email: 'a@a.example' }, { Email: '' }, { Email: 'c@a.example' }])
  past(sid)
  const now = clock()
  const id = db.prepare('SELECT id FROM autorun_columns WHERE sheet_id = ?').pluck().get(sid) as string
  await autorunTick(id)
  await idle(sid)
  assert.equal(queued.length, 1, 'the run was handed to the queue')
  assert.deepEqual(cells(sid, 'Push'), ['', '⏳ Processing...', '', '⏳ Processing...'])
  assert.deepEqual(changed(sid, now), [1, 3])
})

await ok("an enrichment's seeding: ⏳ in the rows it runs, the condition mark in the rows kept out", async () => {
  const columns = ['Name', 'Website', 'Size', 'Work email', 'Email']
  const sid = sheet([
    { Name: 'Ada L', Website: 'a.example', Size: '120' },   // runs
    { Name: 'Bo K', Website: 'b.example', Size: '3' },      // kept out by "Only run if"
    { Name: 'Cy', Size: '99' },                             // no website: skipped, untouched
  ], columns)
  const fixture = 'tests/mock-treg/fixtures/catalog/endpoints/treg.people.email.find.json'
  const find = normalizeTool(JSON.parse(fs.readFileSync(fixture, 'utf8')))!
  const body = JSON.stringify({ full_name: '{{Name}}', domain: '{{Website}}' })
  const config = {
    requestConfig: { method: 'POST' as const, url: '', body },
    responseMapping: [], previewSize: 5, enrichment: { toolSnapshot: requestToolOf(find), cleanDomains: true },
  }
  const runId = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, placeholder_work)
    VALUES (?,?,?,?, 'pending', 'Work email', 'seeding')`).run(runId, sid, uid, JSON.stringify(config))
  past(sid)
  const now = clock()
  const before = queued.length
  await asRunStart(sid, uid, async () => {
    seedEnrichmentThenEnqueue({
      runId, sheetId: sid, userId: uid, columns: ['Work email', 'Email'],
      plan: { statusColumn: null, status: 'any', where: [{ column: 'Size', op: 'gt', value: '50' }], rule: null,
        config: config as never, columns },
      rowFilter: { clause: '', params: [] }, targets: null, lastRow: 2, test: null,
    })
    return {}
  })
  await idle(sid)
  assert.equal(queued.length, before + 1, 'the run was handed to the queue')
  assert.deepEqual(cells(sid, 'Work email'), ['⏳ Processing...', '⏭️ Condition not met', ''])
  assert.deepEqual(cells(sid, 'Email'), ['⏳ Processing...', '', ''])
  assert.deepEqual(changed(sid, now), [0, 1])
})

done()
