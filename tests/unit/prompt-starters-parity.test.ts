// The server's prompt starters (server/src/lib/prompt-starters.ts, for list_prompt_starters and REST) and the
// app's (client/src/lib/prompt-starters.ts, the AI column dialog) are two copies of one list: the client can't
// import server code. This fails if they ever give different starters for the same columns, so a change to one
// copy must go into the other. Pure, no DB. Also: a starter as run_ai_column's arguments (starterRunArgs).
import assert from 'node:assert/strict'
import * as client from '../../client/src/lib/prompt-starters'
import { columnToken } from '../../client/src/lib/output-columns'
import serverMod from '../../server/src/lib/prompt-starters'
import promptMod from '../../server/src/lib/prompt'
const server = serverMod as typeof import('../../server/src/lib/prompt-starters')
const { normalizeColumnName } = promptMod as typeof import('../../server/src/lib/prompt')

let failures = 0
function check(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) } catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).message) }
}

// Column lists that reach every rule: each slot's words, first match wins, a run's (Status)/(Data) columns left
// out, taken names (" 2"), the fallback to the first columns, and none at all.
const LISTS: string[][] = [
  [], ['Notes'], ['A', 'B', 'C', 'D', 'E', 'F'],
  ['First name', 'Last name', 'Job title', 'Company name', 'Company website', 'Industry', 'Employees', 'Country',
    'Score (Status)', 'Score (Data)'],
  ['Full name', 'Email', 'LinkedIn URL', 'Headline', 'Organisation', 'Domain', 'Sector', 'Headcount', 'HQ', 'About'],
  ['Name', 'Qualified', 'Category', 'Opener', 'Lead score', 'Company profile', 'Industry', 'Employees',
    'Headquarters', 'Founded', 'B2B', 'Summary', 'Qualified 2'],
  ['contact', 'e-mail', 'url', 'given_name', 'team size', 'vertical', 'employer', 'role', 'bio', 'city'],
  ['Qualified (Output)', 'Opener (Status)', 'Company (Data)', '  ', 'Prospect name', 'Seniority', 'Tagline'],
  ['Zoë Müller', 'Größe', '会社', 'Website (old)', 'site', 'homepage', 'Brand', 'Position', 'Keywords', 'Region'],
]

check('the server and the app give the same starters for every column list', () => {
  for (const names of LISTS) {
    const ours = server.promptStarters(names.map(name => ({ name, reference: `/${normalizeColumnName(name)}` })))
    const app = client.promptStarters(names.map(name => ({ name, reference: `/${columnToken(name)}` })))
    assert.deepEqual(ours, app, JSON.stringify(names))
  }
})

check('the two make the same /references (the server\'s normalizeColumnName, the app\'s columnToken)', () => {
  for (const name of LISTS.flat()) assert.equal(normalizeColumnName(name), columnToken(name), name)
})

check('a starter as run_ai_column\'s arguments: column_name and prompt, and output_columns only for a profile', () => {
  const starters = server.promptStarters(LISTS[3].map(name => ({ name, reference: `/${normalizeColumnName(name)}` })))
  for (const s of starters) {
    const run = server.starterRunArgs(s)
    assert.equal(run.column_name, s.columnName)
    assert.equal(run.prompt, s.prompt)
    if (s.id === 'profile') {
      assert.deepEqual(run.output_columns?.map(c => [c.column_name, c.type]), [['Industry 2', 'string'],
        ['Employees 2', 'number'], ['Headquarters', 'string'], ['Founded', 'number'], ['B2B', 'boolean'],
        ['Summary', 'string']])
    } else assert.equal('output_columns' in run, false, s.id)
  }
})

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('prompt starters parity: all passed')
