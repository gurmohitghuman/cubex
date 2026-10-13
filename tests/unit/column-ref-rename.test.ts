// Column rename rewrites the references stored AI prompts and HTTP templates
// make to the column (lib/column-ref-rename.ts), and nothing the run-time
// resolvers wouldn't have resolved to it: URL path segments, longer tokens,
// other columns. Column delete records the column in the HTTP requests that
// read it, so a saved key of its name never stands in (then, against a
// migrated DB: the delete, a rerun, the run's own substitution, auto-run).
import assert from 'node:assert/strict'
import mod from '../../server/src/lib/column-ref-rename'
import promptMod from '../../server/src/lib/prompt'
const { renamePromptColumnRefs, renameTemplateColumnRefs, markTemplateColumnGone } =
  mod as typeof import('../../server/src/lib/column-ref-rename')
const { processPromptTemplate } = promptMod as typeof import('../../server/src/lib/prompt')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

// AI prompts (/token)
assert.equal(renamePromptColumnRefs('What does /company sell? See /website.', 'Website', 'Site URL'),
  'What does /company sell? See /site_url.')
assert.equal(renamePromptColumnRefs('Use /Website and /website2', 'website', 'site'), 'Use /site and /website2')
assert.equal(renamePromptColumnRefs('Open https://x.com/website or www.x.com/website, 24/7', 'website', 'site'),
  'Open https://x.com/website or www.x.com/website, 24/7')
// The prompt resolver doesn't normalize the token, so neither does the rewrite.
assert.equal(renamePromptColumnRefs('/company-domain', 'Company Domain', 'Domain'), '/company-domain')
// A rewritten prompt resolves to the renamed column's value.
const rewritten = renamePromptColumnRefs('Score /company_name', 'Company Name', 'Account')
assert.equal(processPromptTemplate(rewritten, { Account: 'Acme' }), 'Score Acme')

// HTTP templates ({{name}} and /token)
assert.equal(renameTemplateColumnRefs('https://api.github.com/orgs/{{github}}', 'GitHub', 'GH handle'),
  'https://api.github.com/orgs/{{GH handle}}')
assert.equal(renameTemplateColumnRefs('{{ GitHub }} {{github2}} {{other}}', 'github', 'gh'), '{{gh}} {{github2}} {{other}}')
assert.equal(renameTemplateColumnRefs('{"org": "/github", "path": "api.github.com/github"}', 'github', 'GH handle'),
  '{"org": "/gh_handle", "path": "api.github.com/github"}')
// The template resolver normalizes the token, so the rewrite does too.
assert.equal(renameTemplateColumnRefs('/company-domain', 'Company Domain', 'Domain'), '/domain')
assert.equal(renameTemplateColumnRefs('https://x.com/v1/users', 'users', 'people'), 'https://x.com/v1/users')
// A "}" in the new name would end {{...}} early: write the normalized name.
assert.equal(renameTemplateColumnRefs('{{price}}', 'price', 'Price {USD}'), '{{price_usd}}')

// Column delete: the requests that read it record it, once.
const rc: Record<string, unknown> = { url: 'https://x.test/{{email}}', headers: { A: '/Name' }, body: '{}' }
assert.equal(markTemplateColumnGone(rc, 'Email'), true)
assert.equal(markTemplateColumnGone(rc, 'Email'), false)
assert.equal(markTemplateColumnGone(rc, 'name'), true)
assert.deepEqual(rc.goneColumns, ['Email', 'name'])
// Text the resolver skips (a URL path segment) isn't a read.
assert.equal(markTemplateColumnGone({ url: 'https://x.test/v1/users' }, 'users'), false)

deletedColumn().then(() => console.log('All column-ref-rename assertions passed.'))
  .catch(err => { console.error(err); process.exit(1) })

// Push's request reads {{Email}}; a saved key is named Email too.
async function deletedColumn() {
  const { v4: uuid } = await import('uuid')
  const { db } = await import('../../server/src/lib/db')
  const { runMigrations } = await import('../../server/src/db/migrate')
  const { encrypt } = await import('../../server/src/lib/crypto')
  const { sheetBusyWith } = await import('../../server/src/lib/sheet-busy')
  const { deleteSheetColumn } = await import('../../server/src/services/column-delete')
  const { renameSheetColumn } = await import('../../server/src/services/column-rename')
  const { rerunHttpColumn } = await import('../../server/src/services/http-run-rerun')
  const { replaceTemplateVariables } = await import('../../server/src/lib/http-request-template')
  const { savedKeyRefsInConfig } = await import('../../server/src/lib/http-secrets-scan')
  const { saveAutorunSettings } = await import('../../server/src/services/autorun-settings')
  runMigrations()
  const uid = uuid(), tableId = uuid(), sheet = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
  db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
    .run(sheet, tableId, uid, 'S', JSON.stringify(['Email', 'Name', 'Push', 'Log']))
  db.prepare(`INSERT INTO api_keys (id, user_id, name, key_type, key_value_encrypted)
    VALUES (?,?, 'Email', 'custom', ?)`).run(uuid(), uid, encrypt('SECRET-KEY'))
  const config = (url: string) => JSON.stringify({ requestConfig: { method: 'GET', url, headers: {} },
    responseMapping: [], previewSize: 3 })
  const run = (column: string, url: string) => db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config,
    status, master_column_name) VALUES (?,?,?,?, 'completed', ?)`).run(uuid(), sheet, uid, config(url), column)
  run('Push', 'https://x.test/{{Email}}?n={{Name}}')
  run('Log', 'https://x.test/log/{{Email}}')     // another column's run: the paged pass reaches it
  const rcOf = (column: string) => JSON.parse(db.prepare(`SELECT config FROM http_runs WHERE master_column_name = ?
    ORDER BY rowid DESC LIMIT 1`).pluck().get(column) as string).requestConfig
  const idle = async () => { while (sheetBusyWith(sheet)) await new Promise(r => setTimeout(r, 5)) }
  assert.equal(replaceTemplateVariables('{{Email}}', {}, uid), 'SECRET-KEY')   // what a key-named token sends

  assert.ok('ok' in await deleteSheetColumn(sheet, uid, 'Email'))
  await idle()
  assert.deepEqual(rcOf('Push').goneColumns, ['Email'])
  assert.deepEqual(rcOf('Log').goneColumns, ['Email'])
  const message = "This column reads Email, which isn't in this sheet anymore. Edit the column first."
  const rerun = await rerunHttpColumn(uid, { sheetId: sheet, masterColumnName: 'Push' })
  assert.ok('fail' in rerun && rerun.fail === 'bad_request' && rerun.message === message)
  assert.throws(() => replaceTemplateVariables('{{Email}}', {}, uid, 'live', true, undefined, rcOf('Push').goneColumns),
    { message })
  assert.deepEqual(savedKeyRefsInConfig(uid, rcOf('Push')), [])   // no 'secrets' scope asked for a key it never sends
  const auto = await saveAutorunSettings(uid, sheet, { column: 'Log', enabled: true, where: null, dailyCapUsd: null,
    dailyRowCap: null }, { hasSecretsScope: true })
  assert.ok('fail' in auto && auto.message === message)

  // A rename keeps working (the tokens follow it), and a column named Email again is read as before.
  assert.ok('ok' in await renameSheetColumn(sheet, uid, 'Name', 'Full name'))
  await idle()
  assert.equal(rcOf('Push').url, 'https://x.test/{{Email}}?n={{Full name}}')
  db.prepare('UPDATE sheets SET column_order = ? WHERE id = ?')
    .run(JSON.stringify(['Full name', 'Push', 'Log', 'Email']), sheet)
  assert.equal(replaceTemplateVariables('{{Email}}', { Email: 'a@b.co' }, uid, 'live', true, undefined, ['Email']),
    'a@b.co')
  const again = await saveAutorunSettings(uid, sheet, { column: 'Log', enabled: true, where: null,
    dailyCapUsd: null, dailyRowCap: null }, { hasSecretsScope: true })
  assert.ok('ok' in again)
}
