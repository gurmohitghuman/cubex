// Page reading opens only websites found in the row's cells of the columns the prompt names (lib/ai-web-tools.ts
// buildWebTools sends that list, empty included, and an empty list blocks every fetch). fetchFindsNoSite says when the
// rows checked give no site at all, so the estimate says so instead of every row failing quietly to read a page.
import assert from 'node:assert/strict'
import toolsMod from '../../server/src/lib/ai-web-tools'
const { fetchFindsNoSite, FETCH_NO_SITE_NOTE } = toolsMod as typeof import('../../server/src/lib/ai-web-tools')

assert.equal(fetchFindsNoSite('Summarize what /Company does', [{ Company: 'Acme', Website: 'acme.com' }]), true,
  'the prompt names a column with no website in it')
assert.equal(fetchFindsNoSite('Summarize the company', [{ Website: 'acme.com' }]), true, 'it names no column at all')
assert.equal(fetchFindsNoSite('Read /Website and summarize it', [{ Website: '' }, { Website: ' ' }]), true,
  'the named column is empty on every row checked')
assert.equal(fetchFindsNoSite('Read /Website and summarize it', [{ Website: '' }, { Website: 'https://acme.com' }]),
  false, 'one row with a site is enough')
assert.equal(fetchFindsNoSite('Read /website', [{ Website: 'www.acme.com/about' }]), false, 'matched as the run matches')
assert.equal(fetchFindsNoSite('Read /Website', []), false, 'no rows: nothing to say')
assert.match(FETCH_NO_SITE_NOTE, /would open no page/)
console.log('ok   page reading with no site in the named columns is told apart from one with a site')
console.log('ai-fetch-no-site: all assertions passed')
