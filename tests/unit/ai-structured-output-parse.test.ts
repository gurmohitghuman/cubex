// Regression test for the two structured-output parse bugs found auditing the
// 2026-07-24 release (both were live in prod).
//
// Root cause of both: ai-row-multi.ts called extractCompletionText(), which ran
// cleanMarkdown() on the model's text before parseMultiOutput ever saw it.
// cleanMarkdown exists for PROSE cells; on JSON it is destructive.
// server/src is type:commonjs → default-import + destructure under tsx.
import ctMod from '../../server/src/lib/completion-text'
import moMod from '../../server/src/lib/ai-multi-output'
const { extractCompletionText } = ctMod as typeof import('../../server/src/lib/completion-text')
const { parseMultiOutput } = moMod as typeof import('../../server/src/lib/ai-multi-output')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

const specs = [
  { columnName: 'score', type: 'number' as const, description: 'fit score' },
  { columnName: 'reason', type: 'string' as const, description: 'why' },
]
const completion = (content: string) => ({ choices: [{ message: { content }, finish_reason: 'stop' }] })
// Exactly what services/ai-row-multi.ts does.
const asRun = (content: string) =>
  parseMultiOutput(extractCompletionText(completion(content), { cleanMarkdown: false }), specs)

// --- BUG 1: fenced JSON always failed ---------------------------------------
// cleanMarkdown's inline-code rule ate two of the three backticks, leaving
// `json{...}` — which stripCodeFence (anchored on ```) could no longer match,
// so JSON.parse threw and EVERY fenced row got "❌ Model did not return valid
// JSON" with its output columns blanked. Fencing is most models' default habit.
const fencedJson = asRun('```json\n{"score": 8, "reason": "good fit"}\n```')
check('```json fence parses', 'ok' in fencedJson)
check('```json fence keeps values', 'ok' in fencedJson && fencedJson.ok.score === '8')
const bareFence = asRun('```\n{"score": 5, "reason": "maybe"}\n```')
check('bare ``` fence parses', 'ok' in bareFence)
check('unfenced still parses', 'ok' in asRun('{"score": 1, "reason": "no"}'))
check('fence with trailing prose-free whitespace parses',
  'ok' in asRun('   ```json\n{"score": 2, "reason": "x"}\n```   '))

// --- BUG 2: markdown chars stripped from INSIDE JSON string values ----------
// These rows PARSED and wrote ✅, so the corruption was invisible: the user got
// a plausible-looking value that silently differed from what the model said.
const hash = asRun('{"score": 3, "reason": "rank #3 of 10"}')
check('# preserved in value', 'ok' in hash && hash.ok.reason === 'rank #3 of 10')
const stars = asRun('{"score": 4, "reason": "sells *SaaS* and services"}')
check('* preserved in value', 'ok' in stars && stars.ok.reason === 'sells *SaaS* and services')
const ticks = asRun('{"score": 5, "reason": "run `npm install` first"}')
check('backticks preserved in value', 'ok' in ticks && ticks.ok.reason === 'run `npm install` first')
const bullets = asRun('{"score": 6, "reason": "a * b * c"}')
check('bullet-like text preserved', 'ok' in bullets && bullets.ok.reason === 'a * b * c')

// --- prose behavior must be UNCHANGED ----------------------------------------
// cleanMarkdown is still right for single-column cells; only structured runs
// opt out. Regressing this would put raw markdown into every prose cell.
check('prose still markdown-cleaned',
  extractCompletionText(completion('**Bold** and `code`')) === 'Bold and code')
check('prose default is cleaning (no opts)',
  extractCompletionText(completion('# Heading')) === 'Heading')

// --- error detection must survive the raw path -------------------------------
// Only the CLEANING step is skipped; every failure check still has to fire, or
// a blank/refused completion would be written as an empty cell with no error.
function throwsWith(content: string, needle: string, extra?: any): boolean {
  try { extractCompletionText(completion(content), { cleanMarkdown: false }); return false }
  catch (e: any) { return String(e.message).toLowerCase().includes(needle.toLowerCase()) }
}
check('empty content still throws', throwsWith('', 'empty response'))
check('whitespace-only content still throws', throwsWith('   \n  ', 'empty response'))
try {
  extractCompletionText(
    { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] },
    { cleanMarkdown: false },
  )
  check('content_filter still throws', false)
} catch (e: any) { check('content_filter still throws', /content filter/i.test(e.message)) }
try {
  extractCompletionText(
    { choices: [{ message: { content: '', refusal: 'nope' }, finish_reason: 'stop' }] },
    { cleanMarkdown: false },
  )
  check('refusal still throws', false)
} catch (e: any) { check('refusal still throws', /refused/i.test(e.message)) }

// --- parse-failure classification unchanged ----------------------------------
check('non-JSON still fails the row', 'error' in asRun('I think the score is 8'))
check('JSON array still fails the row', 'error' in asRun('[1,2,3]'))
check('missing key coerces to blank, not failure',
  'ok' in asRun('{"score": 9}') && (asRun('{"score": 9}') as any).ok.reason === '')

console.log(failures === 0 ? '\nAll structured-output parse tests passed' : `\n${failures} FAILURES`)
if (failures > 0) process.exit(1)
