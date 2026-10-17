// The AI column dialog's prompt starters (client/src/lib/prompt-starters.ts)
// and its output column checks (client/src/lib/output-columns.ts). Pure, no DB.
// Starters read the sheet's columns by name and write them as /references,
// take names no column has, fall back to the first columns, and use plain
// words (no em dash). The checks catch what the server would refuse.
import { promptStarters } from '../../client/src/lib/prompt-starters'
import { columnToken, outputColumnsBody, outputColumnsError } from '../../client/src/lib/output-columns'

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}
const cols = (names: string[]) => names.map(name => ({ name, reference: `/${columnToken(name)}` }))
const byId = (names: string[]) => Object.fromEntries(promptStarters(cols(names)).map(s => [s.id, s]))
const EM_DASH = String.fromCharCode(0x2014)

const leads = byId(['First name', 'Last name', 'Job title', 'Company name', 'Company website', 'Industry',
  'Employees', 'Country', 'Score (Status)', 'Score (Data)'])
check('five starters, in order', Object.keys(leads).join() === 'qualify,classify,opener,score,profile')
const q = leads.qualify.prompt
check('qualify reads the company columns as /references', q.includes('Company name: /company_name')
  && q.includes('Company website: /company_website') && q.includes('Industry: /industry')
  && q.includes('Employees: /employees') && q.includes('Country: /country'), q)
check('qualify answers YES or NO', leads.qualify.prompt.endsWith('Answer with only YES or NO.'))
check('a person column is not a company detail', !leads.qualify.prompt.includes('/job_title'))
check('the opener greets the first name and reads the title', leads.opener.prompt
  .startsWith('Write the first line of a cold email to /first_name.') && leads.opener.prompt.includes('/job_title'))
check('a run\'s status and sources columns are never read',
  Object.values(leads).every(s => !s.prompt.includes('/score_status') && !s.prompt.includes('/score_data')))
check('lead score answers with a number', leads.score.prompt.includes('from 1 (poor fit) to 10 (perfect fit)')
  && leads.score.prompt.endsWith('Answer with only the number.'))
check('classify lists categories to fill in', leads.classify.prompt.includes('[Category A], [Category B]'))
check('only the profile has output columns', Object.values(leads).every(s => (s.id === 'profile')
  === (s.outputColumns.length > 0)))
check('profile output columns', leads.profile.outputColumns.map(o => `${o.columnName}:${o.type}`).join()
  === 'Industry 2:string,Employees 2:number,Headquarters:string,Founded:number,B2B:boolean,Summary:string',
  leads.profile.outputColumns)
check('plain words: no em dash anywhere', Object.values(leads).every(s => !(s.prompt + s.label + s.hint
  + s.outputColumns.map(o => o.description).join()).includes(EM_DASH)))
check('suggested names', [leads.qualify, leads.classify, leads.opener, leads.score, leads.profile]
  .map(s => s.columnName).join() === 'Qualified,Category,Opener,Lead score,Company profile')

const taken = byId(['Name', 'Qualified (Output)', 'category', 'Opener', 'Company Profile (Status)'])
check('names already taken get a number', taken.qualify.columnName === 'Qualified 2'
  && taken.classify.columnName === 'Category 2' && taken.opener.columnName === 'Opener 2'
  && taken.profile.columnName === 'Company profile 2', [taken.qualify.columnName, taken.classify.columnName])
check('a bare Name column is the person',
  taken.opener.prompt.startsWith('Write the first line of a cold email to /name.'))

const odd = byId(['Col A', 'Col B', 'Col C', 'Col D', 'Col E'])
check('no column fits: the first four', odd.qualify.prompt.includes('Col A: /col_a\nCol B: /col_b\nCol C: /col_c\n'
  + 'Col D: /col_d') && !odd.qualify.prompt.includes('/col_e'))
check('no name column: "this person"',
  odd.opener.prompt.startsWith('Write the first line of a cold email to this person.'))
const empty = byId([])
check('an empty sheet says how to add columns',
  empty.qualify.prompt.includes('[Type / to add the columns it should read]'))
const site = byId(['Website', 'About', 'Company LinkedIn', 'Company size'])
const sq = site.qualify.prompt
check('website, about, LinkedIn and size are read', sq.includes('Website: /website') && sq.includes('About: /about')
  && sq.includes('Company LinkedIn: /company_linkedin') && sq.includes('Company size: /company_size'))

// The output column checks.
const out = (columnName: string, type: 'string' | 'number' | 'boolean' = 'string') =>
  ({ columnName, type, description: ' d ' })
check('none: fine', outputColumnsError([], ['A'], 'X') === '')
check('good ones: fine', outputColumnsError([out('Industry'), out('Size', 'number')], ['Name'], 'Profile') === '')
check('a blank name', outputColumnsError([out('  ')], [], 'X') === 'Give every output column a name.')
check('no letter or digit', /letter A-Z or digit/.test(outputColumnsError([out('###')], [], 'X')))
check('two the same by /reference', outputColumnsError([out('Fit Score'), out('fit-score')], [], 'X')
  === '"Fit Score" and "fit-score" would both be /fit_score. Use different names.')
check('a column the sheet has', outputColumnsError([out('industry')], ['Industry'], 'X')
  === 'This sheet already has a column "Industry". Pick another name for "industry".')
check('the run\'s own status column', /own status column/.test(outputColumnsError([out('Profile (Status)')], [],
  'Profile')))
check('at most 20', /at most 20/.test(outputColumnsError(Array.from({ length: 21 }, (_, i) => out(`C${i}`)), [], 'X')))
check('the body trims', JSON.stringify(outputColumnsBody([{ columnName: ' A ', type: 'number', description: ' b ' }]))
  === '[{"columnName":"A","type":"number","description":"b"}]')
check('tokens match the server', columnToken('What they sell (Output)') === 'what_they_sell_output'
  && columnToken('  Fit--Score  ') === 'fit_score')

if (failures) { console.error(`${failures} failure(s)`); process.exit(1) }
console.log('prompt-starters: all passed')
