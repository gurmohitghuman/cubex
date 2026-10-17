// Lookup columns against a migrated throwaway DB (services/lookup-*.ts on the
// derived engine): equals and contains, each kind of answer, auto-run
// following the source column, the other sheet changing (by this thread, and
// by a worker thread on its own connection through lib/db.ts, as runs write),
// a sort there, renames and deletes on both sheets, the other sheet deleted,
// a fill waiting while the other sheet is busy, loops refused, dropped keys
// purged, and a sheet nobody looks up logging nothing.
// Over 200 lines: one scenario over two sheets, each step building on the last.
import { v4 as uuid } from 'uuid'
import { Worker } from 'worker_threads'
import { createRequire } from 'module'
import dbMod from '../../server/src/lib/db'
import migMod from '../../server/src/db/migrate'
import colMod from '../../server/src/services/lookup-column'
import fillMod from '../../server/src/services/derived-fill'
import kindMod from '../../server/src/services/lookup-kind'
import followMod from '../../server/src/services/derived-follow'
import markMod from '../../server/src/lib/autorun-mark'
import recMod from '../../server/src/lib/lookup-columns'
import entryMod from '../../server/src/services/autorun-entry'
import renameMod from '../../server/src/services/column-rename'
import deleteMod from '../../server/src/services/column-delete'
import sortMod from '../../server/src/services/sheet-sort'
import crudMod from '../../server/src/services/sheet-crud'
import busyMod from '../../server/src/lib/sheet-busy'
import purgeMod from '../../server/src/services/lookup-purge'
import formulaMod from '../../server/src/services/formula-column'
import setupMod from '../../server/src/services/setup-save'
const { db } = dbMod as typeof import('../../server/src/lib/db')
const { runMigrations } = migMod as typeof import('../../server/src/db/migrate')
const { startLookupColumn } = colMod as typeof import('../../server/src/services/lookup-column')
const { waitForDerivedFill, derivedFillWait } = fillMod as typeof import('../../server/src/services/derived-fill')
const { lookupKind } = kindMod as typeof import('../../server/src/services/lookup-kind')
const { derivedFollowTick } = followMod as typeof import('../../server/src/services/derived-follow')
const { markAutorunEdits } = markMod as typeof import('../../server/src/lib/autorun-mark')
const { lookupColumnFor } = recMod as typeof import('../../server/src/lib/lookup-columns')
const { entryFor } = entryMod as typeof import('../../server/src/services/autorun-entry')
const { renameSheetColumn } = renameMod as typeof import('../../server/src/services/column-rename')
const { deleteSheetColumn } = deleteMod as typeof import('../../server/src/services/column-delete')
const { physicalSortSheet } = sortMod as typeof import('../../server/src/services/sheet-sort')
const { deleteSheet } = crudMod as typeof import('../../server/src/services/sheet-crud')
const { withSheetBusy, sheetBusyWith } = busyMod as typeof import('../../server/src/lib/sheet-busy')
const { checkLookupSources, lookupBackgroundRound } =
  purgeMod as typeof import('../../server/src/services/lookup-purge')
const { startFormulaColumn } = formulaMod as typeof import('../../server/src/services/formula-column')
const { planSetup } = setupMod as typeof import('../../server/src/services/setup-save')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
runMigrations()

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

const uid = uuid(), t1 = uuid(), t2 = uuid(), A = uuid(), B = uuid(), C = uuid()
db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(t1, uid, 'Leads')
db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(t2, uid, 'Accounts')
const sheet = db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
sheet.run(A, t1, uid, 'Leads', JSON.stringify(['Name', 'Domain', 'Company']))
sheet.run(B, t2, uid, 'Companies', JSON.stringify(['Site', 'Firm', 'Industry', 'Country']))
sheet.run(C, t2, uid, 'Spare', JSON.stringify(['X']))
const ids: Record<string, string[]> = { [A]: [], [B]: [] }
const add = (s: string, data: Record<string, string>) => {
  const i = (db.prepare('SELECT IFNULL(MAX(row_index), -1) + 1 FROM rows WHERE sheet_id = ?').pluck().get(s) as number)
  const id = uuid()
  db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    .run(id, s, uid, i, JSON.stringify(data))
  ids[s].push(id)
}
add(B, { Site: 'acme.com', Firm: 'Acme Corporation', Industry: 'Robots', Country: 'US' })
add(B, { Site: '  GLOBEX.COM ', Firm: 'Globex Société', Industry: 'Energy', Country: 'FR' })
add(B, { Site: 'initech.com', Firm: 'Initech', Industry: '⏳ Processing...', Country: 'US' })
add(B, { Site: 'acme.com', Firm: 'Acme Labs', Industry: 'Research', Country: 'DE' })
add(A, { Name: 'Ada', Domain: 'ACME.com', Company: 'acme' })
add(A, { Name: 'Bob', Domain: 'globex.com', Company: 'SOCIÉTÉ' })
add(A, { Name: 'Cy', Domain: 'nowhere.io', Company: 'ac' })
add(A, { Name: 'Di', Domain: '❌ failed', Company: '' })
add(A, { Name: 'Ed', Domain: 'initech.com', Company: 'Labs' })

const cells = (s: string, col: string) => (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index')
  .pluck().all(s) as string[]).map(d => JSON.parse(d)[col])
const editA = (row: number, column: string, value: string) => {
  db.prepare('UPDATE rows SET data = json_set(data, ?, ?) WHERE id = ?').run(`$."${column}"`, value, ids[A][row])
  markAutorunEdits(A, uid, [{ column, rowId: ids[A][row] }])
}
const editB = (row: number, column: string, value: string) =>
  db.prepare('UPDATE rows SET data = json_set(data, ?, ?) WHERE id = ?').run(`$."${column}"`, value, ids[B][row])
const follow = async (column: string) => { await derivedFollowTick(entryFor(A, uid, column)!) }
const settle = () => new Promise(r => setTimeout(r, 50))
// Until no fill holds the sheet (a formula column's fill runs in the background).
const idle = async (s: string) => { while (sheetBusyWith(s)) await settle() }
const requireHere = createRequire(import.meta.url)
async function create(column: string, extra: Record<string, unknown>) {
  const out = await startLookupColumn(uid, A, { column, otherSheetId: B, ...extra })
  if ('ok' in out) await waitForDerivedFill(lookupKind, out.ok.id, 5_000)
  await settle()
  return out
}
const dirtyOf = (s: string) => db.prepare('SELECT count(*) FROM lookup_dirty WHERE sheet_id = ?').pluck().get(s)
const keysOf = (col: string) => db.prepare(`SELECT count(*) FROM lookup_keys k JOIN lookup_sources s
  ON s.id = k.source_id WHERE s.sheet_id = ? AND s.column_name = ?`).pluck().get(B, col) as number

// A run worker's write: its own thread and connection, opened through lib/db.ts.
function workerWrite(rowId: string, column: string, value: string): Promise<void> {
  const tsx = requireHere.resolve('tsx/cjs/api')
  const dbFile = requireHere.resolve('../../server/src/lib/db')
  const code = `require(${JSON.stringify(tsx)}).register();
    const { db } = require(${JSON.stringify(dbFile)});
    const { workerData } = require('worker_threads');
    db.prepare('UPDATE rows SET data = json_set(data, ?, ?) WHERE id = ?')
      .run('$."' + workerData.column + '"', workerData.value, workerData.rowId);
    db.close();`
  return new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true, workerData: { rowId, column, value } })
    w.on('error', reject)
    w.on('exit', c => (c === 0 ? resolve() : reject(new Error(`worker exited ${c}`))))
  })
}

async function main() {
  const out = await create('Industry', { sourceColumn: 'Domain', matchColumn: 'Site', returns: 'value',
    returnColumn: 'Industry' })
  const rec = lookupColumnFor(A, uid, 'Industry')
  check('a new lookup column starts, listed with auto-run of kind lookup', 'ok' in out && out.ok.created
    && entryFor(A, uid, 'Industry')?.kind === 'lookup' && rec?.fill_status === 'done', { out, rec })
  check('equals ignores case and spaces; the first match in sheet order; a marker reads empty, no match empty',
    JSON.stringify(cells(A, 'Industry')) === JSON.stringify(['Robots', 'Energy', undefined, undefined, undefined]),
    cells(A, 'Industry'))
  check('the fill counts filled rows', rec?.filled_rows === 2, rec)

  await create('Known', { sourceColumn: 'Domain', matchColumn: 'Site', returns: 'exists' })
  await create('How many', { sourceColumn: 'Domain', matchColumn: 'Site', returns: 'count' })
  check('yes/no and counts (an empty value stays empty)',
    JSON.stringify(cells(A, 'Known')) === JSON.stringify(['Yes', 'Yes', 'No', undefined, 'Yes'])
    && JSON.stringify(cells(A, 'How many')) === JSON.stringify(['2', '1', '0', undefined, '1']),
    [cells(A, 'Known'), cells(A, 'How many')])
  await create('All', {
    sourceColumn: 'Domain', matchColumn: 'Site', returns: 'list', returnColumns: ['Firm'], limit: 5,
  })
  check('a list of the matches in sheet order, with the chosen columns',
    cells(A, 'All')[0] === JSON.stringify([{ Firm: 'Acme Corporation' }, { Firm: 'Acme Labs' }]), cells(A, 'All'))

  const c = await create('Firm site', { sourceColumn: 'Company', matchColumn: 'Firm', match: 'contains',
    returns: 'value', returnColumn: 'Country' })
  check('contains: substrings, accents and case folded; under 3 characters is an error; first in sheet order',
    'ok' in c && JSON.stringify(cells(A, 'Firm site'))
      === JSON.stringify(['US', 'FR', '❌ Contains needs at least 3 characters', undefined, 'DE']),
    cells(A, 'Firm site'))
  check('the contains source keeps a text index', (db.prepare(`SELECT with_text FROM lookup_sources
    WHERE sheet_id = ? AND column_name = 'Firm'`).pluck().get(B)) === 1)

  check('refused: looking in its own sheet', 'fail' in await startLookupColumn(uid, A, { column: 'Self',
    otherSheetId: A, sourceColumn: 'Domain', matchColumn: 'Name', returns: 'exists' }))
  await startFormulaColumn(uid, A, { column: 'Upper', formula: '{{Industry}}.toUpperCase()' })
  await idle(A)
  const loop = await startLookupColumn(uid, A, { column: 'Industry', otherSheetId: B, sourceColumn: 'Upper',
    matchColumn: 'Site', returns: 'value', returnColumn: 'Industry' })
  check('refused: a loop through a formula column', 'fail' in loop && /Upper/.test(loop.message), loop)
  const plan = planSetup(uid, A, ['Upper'])
  check('a setup step reading a lookup column lists it as an input (lookups are no setup step)',
    'ok' in plan && plan.ok.inputs.includes('Industry') && plan.ok.steps.length === 1, plan)
  check('a lookup column alone is no setup step', 'fail' in planSetup(uid, A, ['Industry']))

  // Auto-run follows the source column; the other sheet's changes are read when a row is worked out.
  editA(2, 'Domain', 'Initech.com')
  editB(2, 'Industry', 'Software')
  check('a write to a column there nothing matches logs nothing', dirtyOf(B) === 0, dirtyOf(B))
  await follow('Industry')
  check('the edited row is looked up again, reading the other sheet as it is now',
    cells(A, 'Industry')[2] === 'Software', cells(A, 'Industry'))
  check('rows nobody re-ran keep their answers', cells(A, 'Industry')[0] === 'Robots')

  await workerWrite(ids[B][0], 'Site', 'acme.io')
  check('a worker thread\'s write to a looked-up column lands in the change log', dirtyOf(B) === 1, dirtyOf(B))
  await workerWrite(ids[B][0], 'Industry', 'Robotics')
  check('a worker writing another column logs nothing', dirtyOf(B) === 1, dirtyOf(B))
  editA(0, 'Domain', 'acme.io')
  await follow('Industry')
  check('the next lookup reads the worker\'s write', cells(A, 'Industry')[0] === 'Robotics', cells(A, 'Industry'))
  check('and the change log is drained', dirtyOf(B) === 0, dirtyOf(B))

  // A sort there moves the first match.
  add(B, { Site: 'ACME.COM', Firm: 'Acme East', Industry: 'Aardvarks', Country: 'US' })
  editA(4, 'Domain', 'acme.com')
  await follow('Industry')
  check('before a sort the first match is the higher row', cells(A, 'Industry')[4] === 'Research',
    cells(A, 'Industry'))
  const sorted = await physicalSortSheet(B, uid, 'Industry', 'asc')
  check('the other sheet sorts', 'ok' in sorted, sorted)
  editA(4, 'Domain', ' acme.com')
  await follow('Industry')
  check('after it, the row now on top', cells(A, 'Industry')[4] === 'Aardvarks', cells(A, 'Industry'))

  // Renames and deletes on the other sheet.
  const renamed = await renameSheetColumn(B, uid, 'Site', 'Website')
  check('renaming the matched column there rewrites the lookup and its source', 'ok' in renamed
    && lookupColumnFor(A, uid, 'Industry')?.match_column === 'Website' && keysOf('Website') > 0, renamed)
  await renameSheetColumn(B, uid, 'Industry', 'Sector')
  check('renaming a returned column there rewrites it',
    lookupColumnFor(A, uid, 'Industry')?.return_columns === '["Sector"]')
  editA(1, 'Domain', 'GLOBEX.com ')
  await follow('Industry')
  check('it still looks up after both renames', cells(A, 'Industry')[1] === 'Energy', cells(A, 'Industry'))
  await renameSheetColumn(A, uid, 'Domain', 'Web')
  check('renaming the column it reads here rewrites it',
    lookupColumnFor(A, uid, 'Industry')?.source_column === 'Web'
    && entryFor(A, uid, 'Industry')?.input_columns === '["Web"]')

  await deleteSheetColumn(B, uid, 'Country')
  check('deleting a returned column there stops that lookup with a message',
    /"Country" in "Companies" was deleted/.test(lookupColumnFor(A, uid, 'Firm site')?.broken ?? ''),
    lookupColumnFor(A, uid, 'Firm site'))
  editA(0, 'Company', 'globex')
  await follow('Firm site')
  check('its auto-run pauses with that message', entryFor(A, uid, 'Firm site')?.paused_reason === 'setup'
    && /was deleted/.test(entryFor(A, uid, 'Firm site')?.paused_message ?? ''), entryFor(A, uid, 'Firm site'))

  // A fill waits while the other sheet is busy, with the sheet free meanwhile.
  let release!: () => void
  const held = new Promise<void>(r => { release = r })
  const hold = withSheetBusy(B, 'sorting', () => held)
  const waiting = await startLookupColumn(uid, A, { column: 'Waits', otherSheetId: B, sourceColumn: 'Web',
    matchColumn: 'Website', returns: 'exists' })
  await new Promise(r => setTimeout(r, 300))
  const w = 'ok' in waiting ? lookupColumnFor(A, uid, 'Waits') : undefined
  check('a fill waits while the other sheet sorts, saying so', w?.fill_status === 'filling'
    && /Waiting for "Companies" to finish sorting/.test(derivedFillWait(w!.id) ?? ''), [w, waiting])
  const free = await startFormulaColumn(uid, A, { column: 'Free', formula: '{{Name}}' })
  check('and this sheet stays free meanwhile', 'ok' in free, free)
  await idle(A)
  release(); await hold
  await waitForDerivedFill(lookupKind, w!.id, 5_000)
  check('then it finishes', lookupColumnFor(A, uid, 'Waits')?.fill_status === 'done'
    && cells(A, 'Waits')[0] === 'Yes', [lookupColumnFor(A, uid, 'Waits'), cells(A, 'Waits')])

  // Deleting a lookup column drops a source nobody else reads; its keys go in slices.
  const firmSources = db.prepare("SELECT count(*) FROM lookup_sources WHERE column_name = 'Firm'").pluck()
  await deleteSheetColumn(A, uid, 'Firm site')
  check('a source nobody reads goes with the last lookup reading it', firmSources.get() === 0)
  check('its keys are queued for purging',
    (db.prepare('SELECT count(*) FROM lookup_purges').pluck().get() as number) > 0)
  for (let i = 0; i < 5; i++) await lookupBackgroundRound()
  check('the background loop deletes them, text index included', db.prepare(`SELECT count(*) FROM lookup_keys
    WHERE source_id NOT IN (SELECT id FROM lookup_sources)`).pluck().get() === 0
    && db.prepare('SELECT count(*) FROM lookup_purges').pluck().get() === 0
    && db.prepare(`SELECT count(*) FROM lookup_text WHERE lookup_text MATCH '"acm"'`).pluck().get() === 0)

  // The other sheet deleted: a trigger stops its lookups and drops its sources first.
  const before = db.prepare('SELECT count(*) FROM lookup_dirty').pluck().get()
  const gone = deleteSheet(uid, t2, B)
  check('the other sheet is deleted', 'ok' in gone, gone)
  check('its lookups stop with a message', /The sheet "Companies" it looks in was deleted/
    .test(lookupColumnFor(A, uid, 'Industry')?.broken ?? ''), lookupColumnFor(A, uid, 'Industry'))
  check('its rows logged nothing (sources dropped first)',
    db.prepare('SELECT count(*) FROM lookup_dirty').pluck().get() === before)
  check('no source is left on it', db.prepare('SELECT count(*) FROM lookup_sources WHERE sheet_id = ?').pluck()
    .get(B) === 0)

  // A sheet nobody looks up logs nothing.
  editA(1, 'Name', 'Bobby')
  check('writes to a sheet nobody looks up log nothing', dirtyOf(A) === 0)
  checkLookupSources()
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'lookup_%'")
    .pluck().all() as string[]
  check('every lookup trigger exists after the migrations', triggers.length === 7, triggers)

  console.log(failures === 0 ? '\nlookup columns: all passed' : `\nlookup columns: ${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
