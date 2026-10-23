// AI visibility tables' pure parts: the formulas run in the real formula
// sandbox (a brand found as a whole word, ignoring case and accents; its place
// among the brands an answer names; how many engines name you; who most
// engines name first; your site among the cited ones), rewriting the brand
// list and domain between their markers, and the create input's parse.
// server/src is type:commonjs → default-import + destructure under tsx.
import refsMod from '../../server/src/lib/formula/refs'
import cellsMod from '../../server/src/lib/formula/cells'
import sandboxMod from '../../server/src/lib/formula/sandbox'
import formulasMod from '../../server/src/lib/ai-visibility/formulas'
import inputMod from '../../server/src/lib/ai-visibility/input'
const { compileFormula } = refsMod as typeof import('../../server/src/lib/formula/refs')
const { formulaRow } = cellsMod as typeof import('../../server/src/lib/formula/cells')
const { FormulaSandbox } = sandboxMod as typeof import('../../server/src/lib/formula/sandbox')
const F = formulasMod as typeof import('../../server/src/lib/ai-visibility/formulas')
const { parseAiVisibilityInput, parseBrands } = inputMod as typeof import('../../server/src/lib/ai-visibility/input')

let failures = 0
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, got === undefined ? '' : JSON.stringify(got)) }
}

// Runs a formula over rows given by column name.
async function run(formula: string, columns: string[], rows: Array<Record<string, string>>): Promise<string[]> {
  const compiled = compileFormula(formula, columns)
  const sb = await FormulaSandbox.open(compiled)
  try {
    const out = sb.runRows(rows.map(r => formulaRow(compiled.inputs.map(c => r[c] ?? ''))), 1000).outcomes
    return out.map(o => (o.ok ? o.value : `ERR ${o.error}`))
  } finally { sb.dispose() }
}

async function main() {
  const brands = ['Acme', 'Northdesk', 'Café Labs', 'C++ Tools']
  const you = await run(F.youFormula('ChatGPT answer', brands), ['ChatGPT answer'], [
    { 'ChatGPT answer': 'Try Acme first; Northdesk is fine too.' },
    { 'ChatGPT answer': 'Northdesk leads, then **Acme**, then cafe labs.' },
    { 'ChatGPT answer': 'Nothing here mentions it. Acmeville is a town.' },
    { 'ChatGPT answer': '' },
    { 'ChatGPT answer': '⏳ Processing...' },
    { 'ChatGPT answer': 'CAFÉ LABS and c++ tools, and acme.' },
  ])
  check('your place among the brands named', you[0] === '1st of 2' && you[1] === '2nd of 3', you)
  check('a brand inside another word is not named', you[2] === 'Not named', you[2])
  check('no answer (or a run marker) is blank', you[3] === '' && you[4] === '', you)
  check('case, accents and regex characters', you[5] === '3rd of 3', you[5])

  const answers = ['A answer', 'B answer', 'C answer']
  const by = await run(F.namedByFormula(answers, brands), answers, [
    { 'A answer': 'Acme first', 'B answer': 'Northdesk only', 'C answer': '' },
    { 'A answer': 'Pipewell', 'B answer': 'none', 'C answer': 'Northdesk' },
    { 'A answer': '', 'B answer': '', 'C answer': '' },
  ])
  check('named by: engines that answered and named you', by[0] === '1 of 2' && by[1] === '0 of 3' && by[2] === '', by)

  const firstCols = answers
  const first = await run(F.namedFirstFormula(firstCols, brands), firstCols, [
    { 'A answer': 'Northdesk, then Acme', 'B answer': 'Acme only', 'C answer': 'northdesk is great' },
    { 'A answer': 'none of them', 'B answer': '', 'C answer': 'Acme' },
    { 'A answer': 'none', 'B answer': '', 'C answer': '' },
  ])
  check('named first: the brand most engines name first', first[0] === 'Northdesk' && first[1] === 'Acme'
    && first[2] === '', first)

  const site = await run(F.yourSiteFormula('Domain', 'acme.com'), ['Domain'], [
    { Domain: 'acme.com' }, { Domain: 'blog.acme.com' }, { Domain: 'notacme.com' }, { Domain: '' },
  ])
  check('your site: your domain and its subdomains only', site.join('|') === 'Yes|Yes||', site)
  check('no domain given: never yours',
    (await run(F.yourSiteFormula('Domain', null), ['Domain'], [{ Domain: 'acme.com' }]))[0] === '')

  const rewritten = F.withBrands(F.youFormula('Gemini answer', brands).replace('{{Gemini answer}}', '{{Gem}}'),
    ['Zeta', 'Acme'])
  check('new brands go between the markers, the rest kept', !!rewritten && rewritten.includes('["Zeta","Acme"]')
    && rewritten.includes('{{Gem}}') && !rewritten.includes('Northdesk'))
  check('a formula without the markers is left alone', F.withBrands('{{A}} + 1', ['X']) === null)
  const overlap = await run(F.youFormula('A', ['Acme CRM', 'Acme', 'CRM']), ['A'], [
    { A: 'Acme CRM is good, and Acme has others.' }, { A: 'Plain Acme first, then Acme CRM.' },
  ])
  check('a name inside a longer one found there counts once, as the longer', overlap[0] === '1st of 1'
    && overlap[1] === '2nd of 2', overlap)

  // --- Input ---------------------------------------------------------------------
  const ok = parseAiVisibilityInput({
    brand: '  Acme ', competitors: ['Northdesk', 'acme', 'Northdesk'], domain: 'https://www.Acme.com/pricing',
    questions: ['Best CRM for a small team?', ' best crm for a small team? ', '', 'Cheapest CRM?'], country: 'gb',
  })
  check('input: trimmed, deduped, domain cleaned, default engines, country upper case',
    typeof ok === 'object' && ok.brand === 'Acme' && ok.competitors.join() === 'Northdesk'
    && ok.domain === 'acme.com' && ok.questions.length === 2 && ok.country === 'GB'
    && ok.engines.join() === 'chatgpt,gemini,ai_mode,perplexity', ok)
  const bad = (v: Record<string, unknown>) => typeof parseAiVisibilityInput({ brand: 'Acme', questions: ['Q?'], ...v })
    === 'string'
  check('input refuses: no brand, braces, comment marks, a bad domain, country, engine, no questions',
    bad({ brand: '' }) && bad({ brand: 'A{{B}}' }) && bad({ competitors: ['x*/y'] }) && bad({ domain: 'not a site' })
    && bad({ country: 'USA' }) && bad({ engines: ['bing'] }) && bad({ engines: [] }) && bad({ questions: [' '] }))
  check('engines keep the table order', (parseAiVisibilityInput({ brand: 'A', questions: ['Q'],
    engines: ['copilot', 'chatgpt'] }) as { engines: string[] }).engines.join() === 'chatgpt,copilot')
  const many = Array.from({ length: 20 }, (_, i) => `${'"'.repeat(57)} ${i}`)
  const longest = F.namedFirstFormula(['ChatGPT answer', 'Gemini answer', 'AI Mode answer', 'Perplexity answer',
    'Copilot answer'], ['"'.repeat(60), ...many])
  check('the most brands, at their longest, still fit a formula',
    typeof parseBrands({ brand: '"'.repeat(60), competitors: many }) === 'object' && longest.length < 4000,
    longest.length)
  check('more brands than allowed are refused', typeof parseBrands({ brand: 'A', competitors: [...many, 'x'] })
    === 'string')

  if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
  console.log('\nall AI visibility formula checks passed')
}

main().catch(err => { console.error(err); process.exit(1) })
