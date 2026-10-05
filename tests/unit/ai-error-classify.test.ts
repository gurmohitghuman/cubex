// Unit test for lib/ai-error-classify.ts.
// Every message below is either produced verbatim by our own code
// (lib/completion-text.ts, services/ai-row.ts) or is a real OpenRouter/SDK
// shape — NOT invented strings that happen to match the regexes. A classifier
// tested only against its own patterns proves nothing.
// server/src is type:commonjs → default-import + destructure under tsx.
import errorClassify from '../../server/src/lib/ai-error-classify'
const { classifyAiError, summarizeErrorClasses, AI_ERROR_CLASS_HINT } =
  errorClassify as typeof import('../../server/src/lib/ai-error-classify')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
function classifies(msg: string, expected: string) {
  const got = classifyAiError(msg)
  check(`${expected.padEnd(15)} <- ${msg.slice(0, 58)}`, got === expected)
}

// --- retryable: transport + provider transients ------------------------------
// ai-row.ts appends the cause code to the SDK's bare "Connection error."
classifies('Connection error. (ECONNRESET)', 'retryable')
classifies('Connection error. (EPIPE)', 'retryable')
classifies('Connection error. (ETIMEDOUT)', 'retryable')
classifies('Request timed out.', 'retryable')
classifies('429 Rate limit exceeded', 'retryable')
classifies('502 Bad Gateway', 'retryable')
classifies('503 Service Unavailable', 'retryable')
classifies('Provider returned error', 'retryable')

// --- prompt_content: rewording is the fix ------------------------------------
// completion-text.ts writes these two verbatim.
classifies('Model refused to answer: I cannot help with generating spam.', 'prompt_content')
classifies('Model output was blocked by a content filter.', 'prompt_content')
// prompt-ref-validate.ts / prompt.ts substitution failure.
classifies('unknown column reference /Company — did you mean /company_fit_output?', 'prompt_content')
classifies('[MISSING: /Company]', 'prompt_content')

// --- model_output: nothing usable came back ----------------------------------
// All three are completion-text.ts messages, verbatim.
classifies(
  'Model tried to call a tool that did not run (unresolved tool call). Try a different model, or turn off web search / URL fetching.',
  'model_output',
)
classifies(
  'Model returned no text (hit the output token limit, usually a reasoning model thinking past the budget). Try a non-reasoning model or a smaller prompt.',
  'model_output',
)
classifies('Model returned an empty response (finish_reason=stop).', 'model_output')
classifies('Model returned only formatting with no usable text.', 'model_output')

// --- configuration: a rerun cannot fix it ------------------------------------
classifies('No AI model selected. Pick a model in the AI column dialog.', 'configuration')
classifies('401 Unauthorized', 'configuration')
classifies('No auth credentials found', 'configuration')
classifies('402 Insufficient credits', 'configuration')

// --- unknown: refuse to guess ------------------------------------------------
check('null → unknown', classifyAiError(null) === 'unknown')
check('undefined → unknown', classifyAiError(undefined) === 'unknown')
check('empty → unknown', classifyAiError('') === 'unknown')
check('whitespace → unknown', classifyAiError('   ') === 'unknown')
check('non-string → unknown', classifyAiError(42 as unknown as string) === 'unknown')
classifies('Something entirely novel happened', 'unknown')
// An unrecognized error must NOT be called retryable — that would send a caller
// off to re-bill a run for a reason we do not understand.
check('unrecognized is not retryable', classifyAiError('weird new failure') !== 'retryable')

// --- ordering: the actionable class wins on mixed messages -------------------
// THE dogfood incident: a content-filter kill that surfaces wearing transport
// clothing. "EPIPE" alone is retryable, but a refusal mentioned alongside it
// means retrying is the wrong advice — the specific rule must win.
classifies('Model refused to answer: spam-like content. Connection error. (EPIPE)', 'prompt_content')
classifies('Model output was blocked by a content filter. (ECONNRESET)', 'prompt_content')
// And a credentials problem outranks the 5xx it may arrive with.
classifies('401 Unauthorized — upstream error', 'configuration')

// --- summary aggregation -----------------------------------------------------
const page = [
  'Connection error. (ECONNRESET)',
  'Connection error. (EPIPE)',
  '429 Rate limit exceeded',
  'Model refused to answer: nope.',
  null,
]
const summary = summarizeErrorClasses(page)
check('summary sorted by count desc', summary[0].error_class === 'retryable' && summary[0].count === 3)
check('summary includes prompt_content', summary.some(s => s.error_class === 'prompt_content' && s.count === 1))
check('summary counts null as unknown', summary.some(s => s.error_class === 'unknown' && s.count === 1))
check('summary total equals input', summary.reduce((n, s) => n + s.count, 0) === page.length)
check('every summary row carries a hint', summary.every(s => typeof s.hint === 'string' && s.hint.length > 10))
check('empty input → empty summary', summarizeErrorClasses([]).length === 0)

// --- hints -------------------------------------------------------------------
check('a hint exists for every class',
  (['retryable', 'prompt_content', 'model_output', 'configuration', 'unknown'] as const)
    .every(c => typeof AI_ERROR_CLASS_HINT[c] === 'string' && AI_ERROR_CLASS_HINT[c].length > 10))
// The prompt_content hint must warn about cost — that is its whole job.
check('prompt_content hint warns about re-billing',
  /bill|charge|cost/i.test(AI_ERROR_CLASS_HINT.prompt_content))

console.log(failures === 0 ? '\nAll error-classify tests passed' : `\n${failures} FAILURES`)
if (failures > 0) process.exit(1)
