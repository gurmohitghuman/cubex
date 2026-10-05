// Unit test for lib/ai-multi-output.ts — the pure parse/coerce core of
// structured multi-column AI output. Pure functions, no DB.
// server/src is type:commonjs → default-import + destructure under tsx.
import aiMulti from '../../server/src/lib/ai-multi-output'
import citeMod from '../../server/src/lib/ai-citations'
import dataColMod from '../../server/src/lib/ai-data-column'
import webCostMod from '../../server/src/lib/ai-web-cost'
import promptMod from '../../server/src/lib/prompt'
const { buildMultiOutputInstruction, coerceOutputValue, parseMultiOutput, sourcesFromOutput } =
  aiMulti as typeof import('../../server/src/lib/ai-multi-output')
const { citationsFromCompletion, withSourceUrls } = citeMod as typeof import('../../server/src/lib/ai-citations')
const { aiRunDataColumn } = dataColMod as typeof import('../../server/src/lib/ai-data-column')
const { webFeesPerRow, webInputTokensPerRow } = webCostMod as typeof import('../../server/src/lib/ai-web-cost')
const { extractAllowedDomainsFromRow } = promptMod as typeof import('../../server/src/lib/prompt')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

const specs = [
  { columnName: 'Fit Score', type: 'number' as const, description: 'How well it fits' },
  { columnName: 'Fit Reason', type: 'string' as const, description: 'Why' },
  { columnName: 'Is B2B', type: 'boolean' as const, description: 'B2B?' },
]

// Instruction mentions every column name.
const instr = buildMultiOutputInstruction(specs)
check('instruction lists all keys', ['Fit Score', 'Fit Reason', 'Is B2B'].every(k => instr.includes(k)))

// coerceOutputValue — numbers
check('number from number', coerceOutputValue(8, 'number') === '8')
check('number from numeric string', coerceOutputValue('8.5', 'number') === '8.5')
check('number from junk is blank', coerceOutputValue('N/A', 'number') === '')
check('number from null is blank', coerceOutputValue(null, 'number') === '')
// booleans
check('bool from bool', coerceOutputValue(true, 'boolean') === 'true')
check('bool from yes', coerceOutputValue('yes', 'boolean') === 'true')
check('bool from 0', coerceOutputValue('0', 'boolean') === 'false')
check('bool from junk blank', coerceOutputValue('maybe', 'boolean') === '')
// strings
check('string passthrough', coerceOutputValue('hello', 'string') === 'hello')
check('string from number', coerceOutputValue(3, 'string') === '3')
check('string from object serializes', coerceOutputValue({ a: 1 }, 'string') === '{"a":1}')

// parseMultiOutput — happy path
const good = parseMultiOutput('{"Fit Score": 8, "Fit Reason": "B2B SaaS", "Is B2B": true}', specs)
check('good parse ok', 'ok' in good)
if ('ok' in good) {
  check('good coerces number', good.ok['Fit Score'] === '8')
  check('good coerces string', good.ok['Fit Reason'] === 'B2B SaaS')
  check('good coerces bool', good.ok['Is B2B'] === 'true')
}

// fenced JSON is stripped
const fenced = parseMultiOutput('```json\n{"Fit Score": 5, "Fit Reason": "x", "Is B2B": false}\n```', specs)
check('fenced parse ok', 'ok' in fenced && fenced.ok['Fit Score'] === '5')

// missing key → blank, NOT an error
const missing = parseMultiOutput('{"Fit Score": 9}', specs)
check('missing key blanks, not error', 'ok' in missing && missing.ok['Fit Reason'] === '' && missing.ok['Is B2B'] === '')

// whole-object failures → error (→ status column ❌)
check('prose → error', 'error' in parseMultiOutput('I think it scores 8', specs))
check('array → error', 'error' in parseMultiOutput('[1,2,3]', specs))
check('primitive → error', 'error' in parseMultiOutput('42', specs))
check('empty → error', 'error' in parseMultiOutput('', specs))

// Replies wrapped in prose or followed by a note still parse; real junk still fails.
const wrapped = parseMultiOutput('Here is the result: {"Fit Score": 7, "Fit Reason": "ok", "Is B2B": true} Let me know.', specs)
check('JSON inside a sentence still parses', 'ok' in wrapped && wrapped.ok['Fit Score'] === '7')
const noted = parseMultiOutput('```json\n{"Fit Score": 6}\n```\nSources: stripe.com', specs)
check('a note after the fence still parses', 'ok' in noted && noted.ok['Fit Score'] === '6')
const junk = parseMultiOutput('I think {it} scores 8', specs)
check('braces in prose are still an error, quoting the reply', 'error' in junk && junk.error.includes('its reply began: "I think {it} scores 8"'))
check('sources read from a wrapped reply too', sourcesFromOutput('Done. {"__sources": ["https://a.com"]}').length === 1)

// --- web runs: the __sources key and the helpers around it ------------------
// The instruction without web tools is unchanged (a resumed run rebuilds the
// exact prompt), and with them it adds exactly one line for __sources.
check('no web tools → no __sources line', !instr.includes('__sources') && buildMultiOutputInstruction(specs, {}) === instr)
const webInstr = buildMultiOutputInstruction(specs, { withSources: true })
check('web instruction adds the __sources line', webInstr.includes('"__sources" (array of strings)') && webInstr.split('\n').length === instr.split('\n').length + 1)
check('web instruction is deterministic', webInstr === buildMultiOutputInstruction(specs, { withSources: true }))

check('sources read from the JSON', JSON.stringify(sourcesFromOutput('{"__sources": ["https://a.com/x", "https://b.org"]}')) === '["https://a.com/x","https://b.org"]')
check('sources from a fenced answer', sourcesFromOutput('```json\n{"__sources": ["https://a.com"]}\n```').length === 1)
check('a single string counts', JSON.stringify(sourcesFromOutput('{"__sources": "https://a.com"}')) === '["https://a.com"]')
check('non-URLs, duplicates and junk are dropped',
  JSON.stringify(sourcesFromOutput('{"__sources": ["https://a.com", "https://a.com", "ftp://x.com", "a.com", 42, "https://has space.com"]}')) === '["https://a.com"]')
check('missing key, prose or an array → []', sourcesFromOutput('{"Fit Score": 1}').length === 0
  && sourcesFromOutput('no json here').length === 0 && sourcesFromOutput('["https://a.com"]').length === 0)
check('capped at 20 sources', sourcesFromOutput(JSON.stringify({ __sources: Array.from({ length: 30 }, (_, i) => `https://s${i}.com`) })).length === 20)

check('citations from url_citation annotations', JSON.stringify(citationsFromCompletion({ choices: [{ message: { annotations: [
  { type: 'url_citation', url_citation: { url: 'https://a.com', title: 'A', content: 'text' } },
  { type: 'other' }, { type: 'url_citation', url_citation: {} },
] } }] }).map(c => [c.title, c.url])) === '[["A","https://a.com"]]')
check('no annotations → no citations', citationsFromCompletion({ choices: [{ message: {} }] }).length === 0 && citationsFromCompletion(null).length === 0)
const cite = (url: string) => ({ title: url, url, content: '', snippet: '' })
const merged = (cited: string[], listed: string[], fetchHosts?: string[]) =>
  withSourceUrls(cited.map(cite), listed, fetchHosts).map(c => c.url).join(' ')
check('sources merge with citations once each (trailing slash and case ignored)',
  merged(['https://a.com/'], ['https://A.com', 'https://b.com'], ['b.com']) === 'https://a.com/ https://b.com')
check('a listed page counts on a fetch host, its www and its subdomains',
  merged([], ['https://figma.com', 'https://www.figma.com/about', 'https://help.figma.com/x'], ['figma.com']) === 'https://figma.com https://www.figma.com/about https://help.figma.com/x')
check('a listed page on a host the row could not reach is dropped',
  merged([], ['https://crunchbase.com/figma', 'https://evilfigma.com', 'https://figma.com.evil.io'], ['figma.com']) === '')
check('hosts that search returned count too', merged(['https://news.io/a'], ['https://news.io/b', 'https://other.io/c']) === 'https://news.io/a https://news.io/b')
check('no fetch hosts and no citations: nothing listed counts', merged([], ['https://a.com']) === '')
check('fetch hosts: a URL or bare domain counts; IPs and local names do not',
  JSON.stringify(extractAllowedDomainsFromRow('/a /b /c /d /e', { a: 'https://www.Stripe.com/x', b: 'linear.app', c: '10.0.0.5', d: 'http://192.168.1.1/admin', e: 'printer.local' })) === '["stripe.com","linear.app"]')

const run = (o: object) => ({ column_name: 'Lead (Status)', output_columns: null, data_column: null, use_openrouter_web_search: 0, ...o })
check('structured run: its stored data column', aiRunDataColumn(run({ output_columns: '[]', data_column: 'Lead (Data)' })) === 'Lead (Data)')
check('structured run without web tools: none', aiRunDataColumn(run({ output_columns: '[]' })) === null)
check('single run with search: derived from (Output)', aiRunDataColumn(run({ column_name: 'Pitch (Output)', use_openrouter_web_search: 1 })) === 'Pitch (Data)')
check('single run without search: none', aiRunDataColumn(run({ column_name: 'Pitch (Output)' })) === null)

const fees = webFeesPerRow({ search: true, fetch: true })
check('web fees: search + fetch add up', Math.abs(fees.low - 0.008) < 1e-9 && Math.abs(fees.high - 0.017) < 1e-9)
check('no web tools: no fees, no extra tokens', webFeesPerRow({ search: false, fetch: false }).high === 0 && webInputTokensPerRow({ search: false, fetch: false }).high === 0)
check('fetch adds input tokens', webInputTokensPerRow({ search: false, fetch: true }).low > 0)

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall ai-multi-output checks passed')
