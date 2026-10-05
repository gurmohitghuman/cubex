// Column rename rewrites the references stored AI prompts and HTTP templates
// make to the column (lib/column-ref-rename.ts), and nothing the run-time
// resolvers wouldn't have resolved to it: URL path segments, longer tokens,
// other columns.
import assert from 'node:assert/strict'
import mod from '../../server/src/lib/column-ref-rename'
import promptMod from '../../server/src/lib/prompt'
const { renamePromptColumnRefs, renameTemplateColumnRefs } = mod as typeof import('../../server/src/lib/column-ref-rename')
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

console.log('All column-ref-rename assertions passed.')
