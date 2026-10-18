// Auto-dedupe against a real database (services/auto-dedupe-*.ts, migration
// 040). Pins: keys match the way Remove duplicates reads them, blank and long
// cells never match; turning it on leaves the rows already there and counts
// those sharing a key; an append keeps the oldest (or newest) row of a key,
// duplicates inside one call included, and the rest go to one trash batch a
// day; an edit that gives a row a key another row has is checked, an edit
// that keeps the key isn't; a row a run is working on never goes (its check
// waits, then goes through once the run is over); rows arriving while the
// keys build are checked once they are; a deleted row takes its key, a rename
// moves the setting, a restore brings rows back unchecked; a change waits for
// a run.
// Over 200 lines: one fixture and its scenarios, read top to bottom.
import assert from 'node:assert/strict'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import keyMod from '../../server/src/lib/auto-dedupe/key'
import settingMod from '../../server/src/services/auto-dedupe-setting'
import indexMod from '../../server/src/services/auto-dedupe-index'
import checksMod from '../../server/src/services/auto-dedupe-checks'
import rowsMod from '../../server/src/services/rows-write'
import restoreMod from '../../server/src/services/trash-restore'
import renameMod from '../../server/src/services/column-rename'
import storeMod from '../../server/src/lib/auto-dedupe/store'
import { v4 as uuid } from 'uuid'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { autoDedupeKey, whoGoes } = keyMod as typeof import('../../server/src/lib/auto-dedupe/key')
const { setAutoDedupe, turnOffAutoDedupe, autoDedupeView } =
  settingMod as typeof import('../../server/src/services/auto-dedupe-setting')
const { maintainAutoDedupeSheet } = indexMod as typeof import('../../server/src/services/auto-dedupe-index')
const { runChecks } = checksMod as typeof import('../../server/src/services/auto-dedupe-checks')
const { appendRows, patchRowById } = rowsMod as typeof import('../../server/src/services/rows-write')
const { restoreRows } = restoreMod as typeof import('../../server/src/services/trash-restore')
const { autoDedupeChecking } = storeMod as typeof import('../../server/src/lib/auto-dedupe/store')
const { renameSheetColumn } = renameMod as typeof import('../../server/src/services/column-rename')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

const uid = uuid(), tid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, 'T')
let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}

function sheet(name: string, rows: Array<Record<string, string>>): string {
  const id = uuid()
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
    .run(id, tid, uid, name, JSON.stringify(['Email', 'Name']))
  const ins = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
  rows.forEach((r, i) => ins.run(uuid(), id, uid, i, JSON.stringify(r)))
  return id
}
const emails = (s: string) => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
  .all(s) as string[]).map(d => JSON.parse(d).Email ?? '')
const names = (s: string) => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck()
  .all(s) as string[]).map(d => JSON.parse(d).Name ?? '')
async function turnOn(s: string, keep: 'oldest' | 'newest' = 'oldest') {
  const out = setAutoDedupe(uid, s, { column: 'Email', match: 'email', keep })
  assert.ok('ok' in out, JSON.stringify(out))
  assert.equal(await maintainAutoDedupeSheet(s, uid, Date.now() + 10_000), 'ready')
}
const append = (s: string, rows: Array<Record<string, string>>) => {
  const out = appendRows(s, uid, rows)
  assert.ok('ok' in out, JSON.stringify(out))
  return out.ok
}

async function main() {
  await ok('keys: email cleaner, blank, run status and long cells', () => {
    const spec = { match: 'email' as const, phone_country: null }
    assert.equal(autoDedupeKey(spec, ' Jo@Acme.com '), autoDedupeKey(spec, 'jo@acme.com'))
    assert.equal(autoDedupeKey(spec, ''), null)
    assert.equal(autoDedupeKey(spec, '⏳ Processing...'), null)
    assert.equal(autoDedupeKey({ match: 'text', phone_country: null }, 'x'.repeat(201)), null)
    assert.notEqual(autoDedupeKey({ match: 'text', phone_country: null }, 'x'.repeat(200)), null)
    assert.equal(autoDedupeKey({ match: 'text', phone_country: null }, '🙂'.repeat(200)) !== null, true)
    assert.equal(whoGoes('oldest', 5, 2, 5), 'self')
    assert.equal(whoGoes('newest', 5, 2, 5), 'others')
    assert.equal(whoGoes('oldest', 2, 2, 5), 'others')
    assert.equal(whoGoes('oldest', 2, 2, 2), 'none')
  })

  const A = sheet('A', [{ Email: 'a@x.com' }, { Email: 'b@x.com' }, { Email: 'A@X.com', Name: 'dup' }, {}])
  await ok('turning it on leaves rows as they are and counts those sharing a key', async () => {
    await turnOn(A)
    const v = autoDedupeView(A, uid)!
    assert.equal(v.state, 'on')
    assert.equal(v.shared_rows, 1)
    assert.deepEqual(emails(A), ['a@x.com', 'b@x.com', 'A@X.com', ''])
  })

  await ok('keep oldest: a new row with a key already there, and a repeat inside the call, are not kept', () => {
    const out = append(A, [{ Email: 'A@x.com', Name: 'n1' }, { Email: 'new@x.com' }, { Email: 'NEW@x.com ' },
      { Email: '' }, { Email: 'x'.repeat(201) }])
    assert.equal(out.kept, 3)
    assert.equal(out.rows.length, 5)
    assert.deepEqual([...out.notKept], [out.rows[0].id, out.rows[2].id])
    assert.equal(out.deduped!.removed.length, 2)
    assert.deepEqual(emails(A), ['a@x.com', 'b@x.com', 'A@X.com', '', 'new@x.com', '', 'x'.repeat(201)])
    const item = db.prepare(`SELECT id, row_count, how FROM trash_items WHERE sheet_id = ? AND how = 'auto_dedupe'`)
      .all(A) as Array<{ id: number; row_count: number }>
    assert.equal(item.length, 1)
    assert.equal(item[0].row_count, 2)
    assert.equal(autoDedupeView(A, uid)!.removed_rows, 2)
  })

  await ok('a second append the same day lands in the same batch', () => {
    append(A, [{ Email: 'b@X.com' }])
    const items = db.prepare(`SELECT row_count FROM trash_items WHERE sheet_id = ? AND how = 'auto_dedupe'`).pluck()
      .all(A) as number[]
    assert.deepEqual(items, [3])
  })

  await ok('after a partial restore, a seq once given never names another row', async () => {
    const item = db.prepare(`SELECT id FROM trash_items WHERE sheet_id = ? AND how = 'auto_dedupe'`).pluck()
      .get(A) as number
    const top = db.prepare('SELECT MAX(seq) FROM trash_rows WHERE item_id = ?').pluck().get(item) as number
    assert.ok('ok' in await restoreRows(uid, item, [top]))
    assert.equal(await maintainAutoDedupeSheet(A, uid, Date.now() + 10_000), 'ready')
    const out = append(A, [{ Email: 'b@x.com' }])
    assert.equal(out.deduped!.trashId, item)
    assert.ok(out.deduped!.seqs[0] > top, JSON.stringify(out.deduped!.seqs))
  })

  await ok('keep newest: the new row replaces every older row with its key', async () => {
    setAutoDedupe(uid, A, { keep: 'newest' })
    const out = append(A, [{ Email: 'a@x.com', Name: 'latest' }])
    assert.equal(out.kept, 1)
    assert.equal(out.deduped!.removed.length, 2)
    assert.equal(emails(A).filter(e => e.toLowerCase() === 'a@x.com').length, 1)
    assert.ok(names(A).includes('latest'))
  })

  await ok('an edit giving a row a key is checked; an edit keeping the key is not', () => {
    setAutoDedupe(uid, A, { keep: 'oldest' })
    const blank = append(A, [{ Name: 'typed later' }]).rows[0]
    const p = patchRowById(blank.id, uid, { Email: 'new@x.com' })
    assert.ok('ok' in p)
    assert.equal(p.ok.deduped!.removed[0]?.id, blank.id)
    const kept = db.prepare(`SELECT id FROM rows WHERE sheet_id = ? AND json_extract(data, '$.Email') = 'new@x.com'`)
      .pluck().get(A) as string
    const same = patchRowById(kept, uid, { Name: 'still here' })
    assert.ok('ok' in same && same.ok.deduped === null || ('ok' in same && same.ok.deduped!.removed.length === 0))
  })

  const B = sheet('B', [{ Email: 'run@x.com', Name: 'old', Score: '⏳ Processing...' }])
  await ok('a row a run is working on never goes: its check waits, then goes through', async () => {
    await turnOn(B, 'newest')
    const runId = uuid()
    db.prepare(`INSERT INTO ai_runs (id, user_id, sheet_id, column_name, prompt, model, status)
      VALUES (?, ?, ?, 'Score', 'p', 'm', 'running')`).run(runId, uid, B)
    const out = append(B, [{ Email: 'run@x.com', Name: 'new' }])
    assert.equal(out.deduped!.removed.length, 0)
    assert.equal(out.deduped!.waiting, 1)
    assert.equal(emails(B).length, 2)
    db.prepare("UPDATE ai_runs SET status = 'completed' WHERE id = ?").run(runId)
    db.prepare("UPDATE auto_dedupe_checks SET retry_at = 0").run()
    const r = await runChecks(B, uid, { ownBusy: false, deadline: Date.now() + 5_000 })
    assert.equal(r.removed, 1)
    assert.deepEqual(names(B), ['new'])
  })

  await ok('a change to the setting waits for a run (turning it off never does)', () => {
    const runId = uuid()
    db.prepare(`INSERT INTO ai_runs (id, user_id, sheet_id, column_name, prompt, model, status)
      VALUES (?, ?, ?, 'Score', 'p', 'm', 'running')`).run(runId, uid, B)
    const out = setAutoDedupe(uid, B, { keep: 'oldest' })
    assert.ok('fail' in out && out.fail === 'conflict', JSON.stringify(out))
    assert.ok('ok' in turnOffAutoDedupe(uid, B))
    assert.equal(autoDedupeView(B, uid), null)
    db.prepare("UPDATE ai_runs SET status = 'completed' WHERE id = ?").run(runId)
  })

  await ok('a filled column is refused as the key, with the column to pick instead', () => {
    db.prepare(`INSERT INTO ai_runs (id, user_id, sheet_id, column_name, prompt, model, status)
      VALUES (?, ?, ?, 'Name', 'p', 'm', 'completed')`).run(uuid(), uid, B)
    const out = setAutoDedupe(uid, B, { column: 'Name' })
    assert.ok('fail' in out && /AI column/.test(out.message), JSON.stringify(out))
  })

  const C = sheet('C', Array.from({ length: 50 }, (_, i) => ({ Email: `u${i}@x.com` })))
  await ok('rows arriving while the keys build are checked once they are; auto-run waits for them', async () => {
    const on = setAutoDedupe(uid, C, { column: 'Email', match: 'email' })
    assert.ok('ok' in on && on.ok.state === 'building')
    const out = append(C, [{ Email: 'u7@x.com' }])
    assert.equal(out.deduped!.waiting, 1)
    assert.equal(autoDedupeChecking(C), true)
    assert.equal(await maintainAutoDedupeSheet(C, uid, Date.now() + 10_000), 'ready')
    // Turning the setting on also started its background driver, which may make this check first on a slow
    // machine (Windows CI), so assert the outcome, not which caller removed the row.
    const r = await runChecks(C, uid, { ownBusy: false, deadline: Date.now() + 5_000 })
    assert.ok(r.removed <= 1)
    assert.equal(emails(C).length, 50)
    assert.equal(autoDedupeChecking(C), false)
  })

  await ok('checks waiting on one column are dropped when the key moves to another', () => {
    const D = sheet('D', [{ Email: 'd@x.com', Name: 'same' }, { Email: 'e@x.com', Name: 'same' }])
    setAutoDedupe(uid, D, { column: 'Email', match: 'email' })
    const id = db.prepare('SELECT id FROM auto_dedupe WHERE sheet_id = ?').pluck().get(D) as number
    const rid = db.prepare('SELECT MAX(rowid) FROM rows WHERE sheet_id = ?').pluck().get(D) as number
    db.prepare('INSERT INTO auto_dedupe_checks (dedupe_id, lo, hi) VALUES (?, ?, ?)').run(id, rid, rid)
    assert.ok('ok' in setAutoDedupe(uid, D, { column: 'Name' }))
    const now = db.prepare('SELECT id FROM auto_dedupe WHERE sheet_id = ?').pluck().get(D) as number
    assert.equal(db.prepare('SELECT COUNT(*) FROM auto_dedupe_checks WHERE dedupe_id = ?').pluck().get(now), 0)
  })

  await ok('a deleted row takes its key; a rename moves the setting', async () => {
    const before = db.prepare('SELECT COUNT(*) FROM auto_dedupe_keys k JOIN auto_dedupe a ON a.id = k.dedupe_id '
      + 'WHERE a.sheet_id = ?').pluck()
    const n = before.get(C) as number
    db.prepare("DELETE FROM rows WHERE sheet_id = ? AND json_extract(data, '$.Email') = 'u1@x.com'").run(C)
    assert.equal(before.get(C), n - 1)
    const r = await renameSheetColumn(C, uid, 'Email', 'Work email')
    assert.ok('ok' in r, JSON.stringify(r))
    assert.equal(autoDedupeView(C, uid)!.column, 'Work email')
    const out = appendRows(C, uid, [{ 'Work email': 'u2@x.com' }])
    assert.ok('ok' in out && out.ok.deduped!.removed.length === 1)
  })

  await ok('a restore brings rows back unchecked, and they stay', async () => {
    const item = db.prepare(`SELECT id FROM trash_items WHERE sheet_id = ? AND how = 'auto_dedupe'`).pluck()
      .get(C) as number
    const before = emails(C).length
    const r = await restoreRows(uid, item)
    assert.ok('ok' in r, JSON.stringify(r))
    assert.equal(await maintainAutoDedupeSheet(C, uid, Date.now() + 10_000), 'ready')
    await runChecks(C, uid, { ownBusy: false, deadline: Date.now() + 5_000 })
    assert.equal(emails(C).length, before + 2)
  })

  await ok('turning it off drops the keys a slice at a time', async () => {
    assert.ok('ok' in turnOffAutoDedupe(uid, C))
    assert.equal(autoDedupeView(C, uid), null)
    const purges = db.prepare('SELECT COUNT(*) FROM auto_dedupe_purges').pluck()
    assert.ok((purges.get() as number) >= 1)
    const purgeMod = await import('../../server/src/services/auto-dedupe-purge')
    for (let i = 0; i < 20 && (purges.get() as number) > 0; i++) await purgeMod.autoDedupeBackgroundRound()
    assert.equal(purges.get(), 0)
  })

  console.log(failures === 0 ? '\nauto-dedupe: all passed' : `\nauto-dedupe: ${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main()
