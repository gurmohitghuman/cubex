// Checking an AI visibility table again (lib/ai-visibility/check.ts,
// services/ai-visibility-check*.ts, migration 048) against a migrated
// throwaway DB, without treg: the pure names and dates; what a check refuses
// (no answers yet, no Named by, a check or a run still going); the free part
// as a restart finishes it (dated copies after their sheets, the lookup of
// that day's Named by and the change column after Named by, both filled; the
// check ends stopped, saying the engines weren't asked); the change column
// following new answers (Up, Down) and a new question (New); a copy made
// before a restart taken as it is; a check cut short while asking stopped.
// Over 200 lines: one fixture and the check's scenarios, read top to bottom.
import assert from 'node:assert/strict'
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import pureMod from '../../server/src/lib/ai-visibility/check'
import checkMod from '../../server/src/services/ai-visibility-check'
import storeMod from '../../server/src/services/ai-visibility-check-store'
import runMod from '../../server/src/services/ai-visibility-run'
import copyMod from '../../server/src/services/sheet-copy'
import fillMod from '../../server/src/services/derived-fill'
import lookupKindMod from '../../server/src/services/lookup-kind'
import formulaKindMod from '../../server/src/services/formula-kind'
import followMod from '../../server/src/services/derived-follow'
import markMod from '../../server/src/lib/autorun-mark'
import entryMod from '../../server/src/services/autorun-entry'
import rowsMod from '../../server/src/services/rows-write'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const P = pureMod as typeof import('../../server/src/lib/ai-visibility/check')
const { checkPlan, resumeAiVisibilityChecks } =
  checkMod as typeof import('../../server/src/services/ai-visibility-check')
const S = storeMod as typeof import('../../server/src/services/ai-visibility-check-store')
const { aiVisibilityRecord, aiVisibilityView } = runMod as typeof import('../../server/src/services/ai-visibility-run')
const { copySheetValues } = copyMod as typeof import('../../server/src/services/sheet-copy')
const { waitForDerivedFill } = fillMod as typeof import('../../server/src/services/derived-fill')
const { lookupKind } = lookupKindMod as typeof import('../../server/src/services/lookup-kind')
const { formulaKind } = formulaKindMod as typeof import('../../server/src/services/formula-kind')
const { derivedFollowTick } = followMod as typeof import('../../server/src/services/derived-follow')
const { markAutorunEdits } = markMod as typeof import('../../server/src/lib/autorun-mark')
const { entryFor } = entryMod as typeof import('../../server/src/services/autorun-entry')
const { appendRows } = rowsMod as typeof import('../../server/src/services/rows-write')
if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()
console.warn = () => {}

let failures = 0
const ok = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).stack) }
}
const uid = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')

const BRANDS = ['Acme CRM', 'Northdesk', 'Pipewell']
const ENGINES = [
  { column: 'ChatGPT', answer: 'ChatGPT answer', tool: 'cloro.ai-search.chatgpt.scrape', path: '$.result.text' },
  { column: 'Gemini', answer: 'Gemini answer', tool: 'cloro.ai-search.gemini.scrape', path: '$.result.text' },
]
// A table as the engines left it: three questions (the last never answered),
// one engine run each (asked on the 15th and 16th of September).
function fixture(opts: { asked?: boolean; namedBy?: boolean } = {}) {
  const tid = uuid(), q = uuid(), s = uuid(), vid = uuid()
  db.prepare('INSERT INTO tables (id,user_id,name) VALUES (?,?,?)').run(tid, uid, `AI ${tid.slice(0, 6)}`)
  const cols = ['Question', ...(opts.namedBy === false ? [] : ['Named by']), 'ChatGPT', 'ChatGPT answer', 'Gemini',
    'Gemini answer']
  const sheet = db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,?,?)')
  sheet.run(q, tid, uid, 'Questions', 0, JSON.stringify(cols))
  sheet.run(s, tid, uid, 'Cited sites', 1, JSON.stringify(['Question', 'Engine', 'URL']))
  const ins = db.prepare('INSERT INTO rows (id,sheet_id,user_id,row_index,data) VALUES (?,?,?,?,?)')
  const rows = [
    { Question: 'Best CRM?', 'Named by': '1 of 2', ChatGPT: '✅ 1 row added',
      'ChatGPT answer': 'Acme CRM, or Northdesk.',
      Gemini: '✅ 1 row added', 'Gemini answer': 'Pipewell.' },
    { Question: 'Cheapest CRM?', 'Named by': '0 of 2', ChatGPT: '✅ 1 row added', 'ChatGPT answer': 'Northdesk.',
      Gemini: '⏭️ Not found', 'Gemini answer': 'Pipewell wins.' },
    { Question: 'Nobody asks this?' },
  ]
  rows.forEach((r, i) => ins.run(uuid(), q, uid, i, JSON.stringify(r)))
  ins.run(uuid(), s, uid, 0, JSON.stringify({ Question: 'Best CRM?', Engine: 'ChatGPT', URL: 'https://acme-crm.com' }))
  ENGINES.forEach((e, i) => run(q, e, `2026-09-1${5 + i} 10:00:00`, opts.asked === false ? [] : [0, 1, 2]))
  db.prepare(`INSERT INTO ai_visibility (id, user_id, table_id, questions_sheet_id, sites_sheet_id, brand, competitors,
      country, engines) VALUES (?, ?, ?, ?, ?, 'Acme CRM', '["Northdesk","Pipewell"]', 'US', '["chatgpt","gemini"]')`)
    .run(vid, uid, tid, q, s)
  return { tid, q, s, rec: aiVisibilityRecord(uid, vid)! }
}
// An engine run that asked these rows (a result each).
function run(q: string, e: typeof ENGINES[number], at: string, rows: number[]): string {
  const id = uuid()
  db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, total_rows, processed_rows,
      master_column_name, created_at) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?)`)
    .run(id, q, uid, JSON.stringify({ responseMapping: [{ jsonPath: e.path, columnName: e.answer }],
      enrichment: { v: 1, toolId: e.tool } }), rows.length, rows.length, e.column, at)
  for (const r of rows) {
    db.prepare("INSERT INTO http_results (id, run_id, user_id, row_index, status) VALUES (?, ?, ?, ?, 'completed')")
      .run(uuid(), id, uid, r)
  }
  return id
}
const columnsOf = (sid: string) => JSON.parse(db.prepare('SELECT column_order FROM sheets WHERE id = ?').pluck()
  .get(sid) as string) as string[]
const cellsOf = (sid: string, column: string) => (db.prepare(`SELECT json_extract(data, ?) FROM rows
  WHERE sheet_id = ? ORDER BY row_index`).pluck().all(`$."${column}"`, sid) as Array<string | null>).map(v => v ?? '')
const until = async (ok: () => boolean, what: string, ms = 30_000) => {
  for (const end = Date.now() + ms; !ok();) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise(r => setTimeout(r, 50))
  }
}
const settle = async (sid: string, column: string) => {
  const entry = entryFor(sid, uid, column)
  if (entry) await derivedFollowTick(entry)
}

async function main() {
  await ok('pure: days, free names, dated names that fit', () => {
    assert.equal(P.dayOf('2026-09-16 10:00:00'), '2026-09-16')
    assert.equal(P.daysSince('2026-09-16 10:00:00', Date.parse('2026-10-07T09:59:00Z')), 20)
    assert.equal(P.daysSince('2026-09-16 10:00:00', Date.parse('2026-10-07T10:00:00Z')), 21)
    assert.equal(P.freeName('A', n => n === 'A' || n === 'A 2'), 'A 3')
    const names = P.checkNames('2026-09-16', { questions: 'Q'.repeat(100), sites: 'Cited sites' },
      n => n === 'Cited sites 2026-09-16', n => n === 'named by on 2026-09-16'.replace('n', 'N'))
    assert.ok(names.questionsCopy.endsWith(' 2026-09-16') && names.questionsCopy.length <= 100, names.questionsCopy)
    assert.equal(names.sitesCopy, 'Cited sites 2026-09-16 2')
    assert.equal(names.namedBy, 'Named by on 2026-09-16 2')
    assert.equal(names.change, 'Change since 2026-09-16')
  })

  await ok('a check refuses: no answers yet, no Named by, a check or a run still going', () => {
    const never = fixture({ asked: false })
    const a = checkPlan(uid, never.rec)
    assert.ok('fail' in a && /Ask the engines first/.test(a.message), JSON.stringify(a))
    const noNamedBy = fixture({ namedBy: false })
    const b = checkPlan(uid, noNamedBy.rec)
    assert.ok('fail' in b && b.fail === 'bad_request' && /Named by/.test(b.message), JSON.stringify(b))
    const busy = fixture()
    db.prepare("UPDATE http_runs SET status = 'running' WHERE sheet_id = ? AND master_column_name = 'Gemini'")
      .run(busy.q)
    const c = checkPlan(uid, busy.rec)
    assert.ok('fail' in c && c.fail === 'conflict' && /Gemini is still being asked/.test(c.message), JSON.stringify(c))
    db.prepare("UPDATE http_runs SET status = 'completed' WHERE sheet_id = ?").run(busy.q)
    const plan = checkPlan(uid, busy.rec)
    assert.ok(!('fail' in plan), JSON.stringify(plan))
    S.insertCheck(uid, busy.rec.id, { day: plan.label, at: plan.askedAt }, plan.names, BRANDS)
    const d = checkPlan(uid, busy.rec)
    assert.ok('fail' in d && /still going/.test(d.message), JSON.stringify(d))
  })

  const t = fixture()
  await ok('the plan: the day the answers were asked, the names, not too soon', () => {
    const plan = checkPlan(uid, t.rec)
    assert.ok(!('fail' in plan), JSON.stringify(plan))
    assert.deepEqual({ ...plan, days: 0 }, {
      label: '2026-09-16', askedAt: '2026-09-16 10:00:00', days: 0, soon: false, questions: 3,
      engines: ['ChatGPT', 'Gemini'], names: { questionsCopy: 'Questions 2026-09-16',
        sitesCopy: 'Cited sites 2026-09-16', namedBy: 'Named by on 2026-09-16', change: 'Change since 2026-09-16' },
      picksUp: null,
    })
    assert.ok(plan.days > 21)
    // One question asked again yesterday doesn't date the rest; a day where the asker is.
    const one = fixture()
    run(one.q, ENGINES[0], '2026-10-19 23:30:00', [2])
    const later = checkPlan(uid, one.rec)
    assert.ok(!('fail' in later) && later.label === '2026-09-16', JSON.stringify(later))
    run(one.q, ENGINES[0], '2026-10-20 02:00:00', [0, 1])
    const ny = checkPlan(uid, one.rec, { timeZone: 'America/New_York' })
    assert.ok(!('fail' in ny) && ny.label === '2026-10-19' && ny.names.questionsCopy === 'Questions 2026-10-19',
      JSON.stringify(ny))
    assert.equal(P.dayIn('2026-10-20 02:00:00', null), '2026-10-20')
    assert.equal(P.timeZoneOf('Mars/Olympus'), null)
    assert.match(P.soonNote(0), /^These answers are from today\. /)
    assert.match(P.soonNote(1), /^These answers are 1 day old\. /)
  })

  await ok('a restart finishes the free part: copies, the comparison columns, then stops without asking', async () => {
    const plan = checkPlan(uid, t.rec)
    assert.ok(!('fail' in plan))
    const id = S.insertCheck(uid, t.rec.id, { day: plan.label, at: plan.askedAt }, plan.names, BRANDS)
    resumeAiVisibilityChecks()
    await until(() => ['stopped', 'done'].includes(S.loadCheck(uid, id)!.stage), 'the check')
    const c = S.checkView(S.loadCheck(uid, id)!)
    assert.equal(c.stage, 'stopped')
    assert.equal(c.problems.length, 1)
    assert.match(c.problems[0], /restarted before the engines were asked again/)
    const tabs = db.prepare('SELECT id, name FROM sheets WHERE table_id = ? ORDER BY position').all(t.tid) as
      Array<{ id: string; name: string }>
    assert.deepEqual(tabs.map(x => x.name),
      ['Questions', 'Questions 2026-09-16', 'Cited sites', 'Cited sites 2026-09-16'])
    assert.equal(c.questionsCopySheetId, tabs[1].id)
    assert.equal(c.sitesCopySheetId, tabs[3].id)
    assert.deepEqual(cellsOf(tabs[1].id, 'Gemini'), ['✅ 1 row added', '', ''], 'values only, run words empty')
    assert.deepEqual(cellsOf(tabs[3].id, 'URL'), ['https://acme-crm.com'])
    assert.match(db.prepare('SELECT description FROM sheets WHERE id = ?').pluck().get(tabs[1].id) as string,
      /as they were on 2026-09-16/)
    assert.deepEqual(columnsOf(t.q).slice(0, 4),
      ['Question', 'Named by', 'Change since 2026-09-16', 'Named by on 2026-09-16'], 'after Named by')
    const lookup = db.prepare('SELECT id FROM lookup_columns WHERE sheet_id = ?').pluck().get(t.q) as string
    const formula = db.prepare('SELECT id FROM formula_columns WHERE sheet_id = ?').pluck().get(t.q) as string
    await waitForDerivedFill(lookupKind, lookup, 30_000)
    await waitForDerivedFill(formulaKind, formula, 30_000)
    await settle(t.q, 'Change since 2026-09-16')
    assert.deepEqual(cellsOf(t.q, 'Named by on 2026-09-16'), ['1 of 2', '0 of 2', ''])
    assert.deepEqual(cellsOf(t.q, 'Change since 2026-09-16'), ['Same', 'Same', ''])
    assert.match(db.prepare(`SELECT description FROM column_descriptions WHERE sheet_id = ? AND column_name = ?`)
      .pluck().get(t.q, 'Change since 2026-09-16') as string, /chance/)
    const view = aiVisibilityView(aiVisibilityRecord(uid, t.rec.id)!)
    assert.equal(view.answersAt, '2026-09-16 10:00:00')
    assert.equal(view.checks[0].id, id)
  })

  await ok('the next check picks a stopped one up: its copies and names kept, only engines it didn\'t start', () => {
    const c = S.loadCheck(uid, S.checksOf(uid, t.rec.id)[0].id)!
    const again = checkPlan(uid, t.rec)
    assert.ok(!('fail' in again), JSON.stringify(again))
    assert.equal(again.picksUp, c.id)
    assert.deepEqual(again.engines, ['ChatGPT', 'Gemini'])
    assert.equal(again.names.questionsCopy, 'Questions 2026-09-16')
    const asked = run(t.q, ENGINES[0], '2026-10-20 09:00:00', [0, 1, 2])
    S.updateCheck(uid, c.id, { addRun: { column: 'ChatGPT', runId: asked, rows: 3 } })
    const rest = checkPlan(uid, t.rec)
    assert.ok(!('fail' in rest) && rest.picksUp === c.id && rest.engines.join() === 'Gemini', JSON.stringify(rest))
    // A column renamed since is still the one it asked (matched by its run).
    db.prepare("UPDATE http_runs SET master_column_name = 'ChatGPT 2' WHERE id = ?").run(asked)
    const renamed = S.askedColumns(uid, S.loadCheck(uid, c.id)!)
    assert.ok(renamed.has('ChatGPT 2') && !renamed.has('ChatGPT'), [...renamed].join())
    db.prepare("UPDATE http_runs SET master_column_name = 'ChatGPT' WHERE id = ?").run(asked)
    // fresh: a new check, not the one that stopped.
    const anew = checkPlan(uid, t.rec, { fresh: true })
    assert.ok(!('fail' in anew) && anew.picksUp === null && anew.names.questionsCopy !== c.questions_copy_name,
      JSON.stringify(anew))
    // Asked since by something else: its answers moved on, so a new check copies again.
    run(t.q, ENGINES[1], '2026-10-21 09:00:00', [0])
    const fresh = checkPlan(uid, t.rec)
    assert.ok(!('fail' in fresh) && fresh.picksUp === null, JSON.stringify(fresh))
  })

  await ok('the change column follows new answers and new questions', async () => {
    const ids = db.prepare('SELECT id FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(t.q) as string[]
    const set = db.prepare('UPDATE rows SET data = json_set(data, ?, ?) WHERE id = ?')
    set.run('$."Gemini answer"', 'Acme CRM and Pipewell.', ids[1])
    set.run('$."ChatGPT answer"', 'Northdesk only.', ids[0])
    markAutorunEdits(t.q, uid,
      [{ column: 'Gemini answer', rowId: ids[1] }, { column: 'ChatGPT answer', rowId: ids[0] }])
    await settle(t.q, 'Change since 2026-09-16')
    assert.deepEqual(cellsOf(t.q, 'Change since 2026-09-16'), ['Down 1', 'Up 1', ''])
    const added = appendRows(t.q, uid, [{ Question: 'A new one?', 'ChatGPT answer': 'Acme CRM.' }])
    assert.ok('ok' in added)
    await settle(t.q, 'Named by on 2026-09-16')
    await settle(t.q, 'Change since 2026-09-16')
    assert.equal(cellsOf(t.q, 'Change since 2026-09-16')[3], 'New')
  })

  await ok('a copy made before a restart is taken as it is; a check cut short while asking stops', async () => {
    const u = fixture()
    const plan = checkPlan(uid, u.rec)
    assert.ok(!('fail' in plan))
    const made = await copySheetValues(uid, u.q, { name: plan.names.questionsCopy })
    assert.ok('ok' in made)
    const id = S.insertCheck(uid, u.rec.id, { day: plan.label, at: plan.askedAt }, plan.names, BRANDS)
    resumeAiVisibilityChecks()
    await until(() => S.loadCheck(uid, id)!.stage === 'stopped', 'the second check')
    assert.equal(S.loadCheck(uid, id)!.questions_copy_id, made.ok.sheet.id)
    const names = db.prepare('SELECT name FROM sheets WHERE table_id = ?').pluck().all(u.tid) as string[]
    assert.equal(names.filter(n => n.startsWith('Questions 2026')).length, 1, 'no second copy')
    const asking = S.insertCheck(uid, fixture().rec.id, { day: 'x', at: '2026-09-16 10:00:00' }, plan.names, BRANDS)
    S.updateCheck(uid, asking, { stage: 'asking' })
    resumeAiVisibilityChecks()
    assert.equal(S.loadCheck(uid, asking)!.stage, 'stopped')
    assert.match(S.checkView(S.loadCheck(uid, asking)!).problems[0], /restarted while the engines were being asked/)
    // A sheet by that name that isn't a whole copy of this one is in the way, never taken.
    const v = fixture()
    const vp = checkPlan(uid, v.rec)
    assert.ok(!('fail' in vp))
    db.prepare('INSERT INTO sheets (id,table_id,user_id,name,position,column_order) VALUES (?,?,?,?,9,?)')
      .run(uuid(), v.tid, uid, vp.names.questionsCopy, '[]')
    const blocked = S.insertCheck(uid, v.rec.id, { day: vp.label, at: vp.askedAt }, vp.names, BRANDS)
    resumeAiVisibilityChecks()
    await until(() => S.loadCheck(uid, blocked)!.stage === 'stopped', 'the blocked check')
    assert.match(S.checkView(S.loadCheck(uid, blocked)!).problems[0], /is in the way/)
    assert.equal(S.loadCheck(uid, blocked)!.questions_copy_id, null)
  })

  console.log(failures === 0 ? '\nai visibility check: all passed' : `\nai visibility check: ${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
