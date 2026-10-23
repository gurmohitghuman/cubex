// Pauses that held things with no end, against a migrated throwaway DB. A lookup
// reading a column a paused run holds starts and fills (the rows the run hasn't
// reached read as empty, and the column says so), while a running one still
// refuses it; a waterfall's lookup step doesn't wait on a paused run's ⏳ either.
// A waterfall auto-run OpenRouter paused goes on again: out of credits once
// OpenRouter reports some for the key (never before), a refused key or model,
// and both, once an OpenRouter key is saved.
import { v4 as uuid } from 'uuid'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import colMod from '../../server/src/services/lookup-column'
import fillMod from '../../server/src/services/derived-fill'
import kindMod from '../../server/src/services/lookup-kind'
import viewMod from '../../server/src/services/lookup-view'
import classifyMod from '../../server/src/lib/ai-error-classify'
import entryMod from '../../server/src/services/autorun-entry'
import loopMod from '../../server/src/services/autorun-loop'
import stopMod from '../../server/src/services/autorun-stop'
import waitMod from '../../server/src/services/waterfall-lookup-wait'
import cryptoMod from '../../server/src/lib/crypto'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { startLookupColumn } = colMod as typeof import('../../server/src/services/lookup-column')
const { waitForDerivedFill } = fillMod as typeof import('../../server/src/services/derived-fill')
const { lookupKind, readsFilling } = kindMod as typeof import('../../server/src/services/lookup-kind')
const { lookupColumnView, lookupColumnJson } = viewMod as typeof import('../../server/src/services/lookup-view')
const { isOutOfCredits } = classifyMod as typeof import('../../server/src/lib/ai-error-classify')
const { clearAiKeyPauses } = entryMod as typeof import('../../server/src/services/autorun-entry')
const { autorunTick } = loopMod as typeof import('../../server/src/services/autorun-loop')
const { stopAutorunRun } = stopMod as typeof import('../../server/src/services/autorun-stop')
const { cellStillFilling } = waitMod as typeof import('../../server/src/services/waterfall-lookup-wait')
const { encrypt } = cryptoMod as typeof import('../../server/src/lib/crypto')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid(), t = uuid(), B = uuid(), A = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(t, uid, 'T')
const sheet = db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
sheet.run(B, t, uid, 'Companies', JSON.stringify(['Domain', 'Industry']))
sheet.run(A, t, uid, 'Leads', JSON.stringify(['Company']))
const add = (s: string, data: Record<string, string>) => {
  const i = (db.prepare('SELECT IFNULL(MAX(row_index), -1) + 1 FROM rows WHERE sheet_id = ?').pluck().get(s) as number)
  db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    .run(uuid(), s, uid, i, JSON.stringify(data))
}
const cells = (s: string, col: string) => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index')
  .pluck().all(s) as string[]).map(d => JSON.parse(d)[col] ?? '')
const entryOf = (id: string) => db.prepare('SELECT paused_reason, paused_message FROM autorun_columns WHERE id = ?')
  .get(id) as { paused_reason: string | null; paused_message: string | null }

async function lookups() {
  add(B, { Domain: 'a.co', Industry: 'Retail' })
  add(B, { Domain: 'b.co', Industry: '⏳ Processing...' })
  add(B, { Domain: 'c.co', Industry: 'SaaS' })
  for (const c of ['a.co', 'b.co', 'c.co']) add(A, { Company: c })
  const runId = uuid()
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status)
    VALUES (?,?,?,?,?,?,'paused')`).run(runId, B, uid, 'Industry', 'p', 'm')
  const setRun = (status: string) => db.prepare('UPDATE ai_runs SET status = ? WHERE id = ?').run(status, runId)
  const input = {
    column: 'Industry', sourceColumn: 'Company', otherSheetId: B, matchColumn: 'Domain', match: 'equals',
    returns: 'value', returnColumn: 'Industry',
  }

  const started = await startLookupColumn(uid, A, input)
  check('a lookup into a column a paused run holds starts', 'ok' in started, started)
  if (!('ok' in started)) return
  const rec = await waitForDerivedFill(lookupKind, started.ok.id, 20_000)
  check('... and fills to the end', rec?.fill_status === 'done', rec?.fill_status)
  check("... the row the run hasn't reached reads as empty", JSON.stringify(cells(A, 'Industry'))
    === JSON.stringify(['Retail', '', 'SaaS']), cells(A, 'Industry'))
  check('a paused run holds nothing', readsFilling(rec!) === null, readsFilling(rec!))
  const view = lookupColumnView(rec!)
  check('the column says a paused run there has rows left', /paused run/.test(view.pausedRun ?? '')
    && view.pausedRun!.includes('"Industry" in "Companies"'), view.pausedRun)
  check('... and agents read it as paused_run', lookupColumnJson(view).paused_run === view.pausedRun)

  setRun('running')
  check('a running run fills it', readsFilling(rec!)?.byRun === true, readsFilling(rec!))
  const refused = await startLookupColumn(uid, A, input)
  check('... so a lookup is refused until it is done', 'fail' in refused && refused.fail === 'conflict'
    && /still being filled/.test(refused.message), refused)
  check('... and the paused-run note is gone', lookupColumnView(rec!).pausedRun === null)
  setRun('completed')
  check('a finished run leaves no note', lookupColumnView(rec!).pausedRun === null)

  // A waterfall's lookup step: a paused run's ⏳ doesn't hold it, even while another column of that sheet runs.
  setRun('paused')
  db.prepare(`INSERT INTO ai_runs (id, sheet_id, user_id, column_name, prompt, model, status)
    VALUES (?,?,?,?,?,?,'running')`).run(uuid(), B, uid, 'Domain', 'p', 'm')
  const waits = (column: string) => cellStillFilling('⏳ Processing...', B, uid, column)
  check("a waterfall's lookup step doesn't wait on a paused run's ⏳", !waits('Industry') && waits('Domain'))
}

async function openRouterPauses() {
  check('OpenRouter out of credits is told apart', isOutOfCredits('402 Insufficient credits')
    && isOutOfCredits('402 This request requires more credits, or fewer max_tokens.'))
  check("... and so is a key's own limit", isOutOfCredits('403 Key limit exceeded (daily limit).'))
  check('... from a refused key, a missing model or calls in flight', !isOutOfCredits('401 User not found.')
    && !isOutOfCredits('404 model not found') && !isOutOfCredits('402 This request would exceed your available '
    + 'credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.'))

  // OpenRouter, as the balance read sees it: what's left of each key's limit; /credits refused (an ordinary key).
  const left: Record<string, number> = { 'sk-or-empty': 0, 'sk-or-topped': 5 }
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (!String(url).startsWith('https://openrouter.ai/')) return realFetch(url, init)
    const key = String(new Headers(init?.headers).get('authorization')).replace('Bearer ', '')
    if (!String(url).endsWith('/auth/key')) return new Response('{}', { status: 403 })
    return Response.json({ data: { limit: 10, limit_remaining: left[key] ?? null } })
  }) as typeof fetch

  const W = uuid(), other = uuid(), W2 = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(other, 'x')
  db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(uuid(), other, 'T2')
  const t2 = db.prepare('SELECT id FROM tables WHERE user_id = ?').pluck().get(other) as string
  const columns = ['Email', 'Work email', 'Phone', 'Title', 'Site']
  sheet.run(W, t, uid, 'Waterfalls', JSON.stringify(columns))
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
    .run(W2, t2, other, 'Waterfalls', JSON.stringify(columns))
  const key = (user: string, k: string) => db.prepare(`INSERT INTO settings (id, user_id, openrouter_api_key_encrypted)
    VALUES (?,?,?)`).run(uuid(), user, encrypt(k))
  key(uid, 'sk-or-empty')
  key(other, 'sk-or-topped')
  const entry = (column: string, reason: string, minutesAgo: number, user = uid, sheetId = W) => {
    const id = uuid()
    db.prepare(`INSERT INTO autorun_columns (id, user_id, sheet_id, status_column, kind, input_columns,
      watermark_row_index, paused_reason, paused_message, paused_at)
      VALUES (?,?,?,?,'waterfall','["Email"]',-1,?,'x',datetime('now', ?))`)
      .run(id, user, sheetId, column, reason, `-${minutesAgo} minutes`)
    return id
  }
  const pausedAt = (id: string) => db.prepare('SELECT paused_at FROM autorun_columns WHERE id = ?').pluck().get(id)
  const creditsOld = entry('Work email', 'ai_credits', 10)
  const creditsNew = entry('Phone', 'ai_credits', 0)
  const keyOld = entry('Title', 'ai_key', 10)
  const auth = entry('Site', 'auth', 0)
  const toppedUp = entry('Work email', 'ai_credits', 10, other, W2)
  const before = pausedAt(creditsOld)
  for (const id of [creditsOld, creditsNew, keyOld, toppedUp]) await autorunTick(id)
  check('out of credits goes on once OpenRouter reports credits for the key',
    entryOf(toppedUp).paused_reason !== 'ai_credits', entryOf(toppedUp))
  check('... and waits while it reports none, looking again a few minutes on',
    entryOf(creditsOld).paused_reason === 'ai_credits' && pausedAt(creditsOld) !== before)
  check('... never before those few minutes', entryOf(creditsNew).paused_reason === 'ai_credits')
  check('a refused key or model waits', entryOf(keyOld).paused_reason === 'ai_key')
  globalThis.fetch = realFetch
  clearAiKeyPauses(uid)
  check('saving an OpenRouter key lifts both', entryOf(creditsNew).paused_reason === null
    && entryOf(keyOld).paused_reason === null)
  check("... and leaves treg's pauses alone", entryOf(auth).paused_reason === 'auth')

  // The words a stopped batch leaves on its auto-run.
  for (const [id, reason, words] of [
    [creditsNew, 'ai_credits', /goes on by itself once OpenRouter reports credits/],
    [keyOld, 'ai_key', /saving an OpenRouter key in Settings resumes it too/],
  ] as const) {
    const run = uuid()
    db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, autorun_id,
      worker_generation) VALUES (?,?,?,'{}','running',?,?,1)`).run(run, W, uid, 'Phone', id)
    const row = db.prepare('SELECT * FROM http_runs WHERE id = ?').get(run) as Parameters<typeof stopAutorunRun>[0]
    await stopAutorunRun(row, 1, reason, 'OpenRouter refused the AI step: 4xx', null)
    const e = entryOf(id)
    check(`a batch stopped for ${reason} pauses its auto-run so, saying what lifts it`,
      e.paused_reason === reason && words.test(e.paused_message ?? ''), e)
  }
}

async function main() {
  await lookups()
  await openRouterPauses()
  console.log(failures === 0 ? '\npaused run holds: all passed' : `\npaused run holds: ${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
