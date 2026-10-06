// Web search cost controls, the pure parts: option parsing, the engine plan
// (auto / native / caps), the catalog parser, the Responses API adapter (shapes
// recorded from OpenRouter on 2026-10-05), the "(Data)" cell and the tool
// parameters a row sends. No DB, no network.
// server/src is type:commonjs → default-import + destructure under tsx.
import optMod from '../../server/src/lib/web-search-options'
import planMod from '../../server/src/lib/web-search-plan'
import adapterMod from '../../server/src/lib/responses-adapter'
import cellMod from '../../server/src/lib/ai-data-cell'
import toolsMod from '../../server/src/lib/ai-web-tools'
import ctMod from '../../server/src/lib/completion-text'
import citeMod from '../../server/src/lib/ai-citations'
import callMod from '../../server/src/services/ai-model-call'
const { parseBooleanOption, parseSearchOptions } = optMod as typeof import('../../server/src/lib/web-search-options')
const { planWebSearch, parseSearchCatalog, webSearchSummary } = planMod as typeof import('../../server/src/lib/web-search-plan')
const { completionFromResponse, responseError, searchLogFromResponse, usageOf } = adapterMod as typeof import('../../server/src/lib/responses-adapter')
const { aiDataCellSummary, formatRowCost } = cellMod as typeof import('../../server/src/lib/ai-data-cell')
const { buildWebTools, searchReplayFor, toolCallBudget } = toolsMod as typeof import('../../server/src/lib/ai-web-tools')
const { extractCompletionText } = ctMod as typeof import('../../server/src/lib/completion-text')
const { citationsFromCompletion } = citeMod as typeof import('../../server/src/lib/ai-citations')
const { refusesTemperature } = callMod as typeof import('../../server/src/services/ai-model-call')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
const throws = (fn: () => unknown, text: string) => { try { fn(); return false } catch (e) { return (e as Error).message.includes(text) } }

// --- options -----------------------------------------------------------------
check('booleans: true/false and their text', parseBooleanOption('true') === true && parseBooleanOption(false) === false
  && parseBooleanOption('false') === false && parseBooleanOption(undefined) === undefined && parseBooleanOption('yes') === 'invalid')
const opts = (raw: object, on = true) => parseSearchOptions(raw, on)
check('search off, nothing given: no options', JSON.stringify(opts({}, false)) === '{"ok":null}')
check('search off, an engine given: refused', 'error' in opts({ engine: 'exa' }, false))
check('search on, nothing given: auto, default mode, no cap',
  JSON.stringify(opts({})) === JSON.stringify({ ok: { engine: 'auto', mode: null, maxPerRow: null } }))
check('engine and mode are case-insensitive', JSON.stringify(opts({ engine: 'Parallel', mode: 'FAST' })) === JSON.stringify({ ok: { engine: 'parallel', mode: 'fast', maxPerRow: null } }))
check('a mode needs exa or parallel', 'error' in opts({ engine: 'auto', mode: 'fast' }))
check('a mode must belong to its engine', 'error' in opts({ engine: 'exa', mode: 'turbo' }))
check('cap as text is a number', (opts({ maxPerRow: '3' }) as any).ok.maxPerRow === 3)
check('cap 0 and 11 refused', 'error' in opts({ maxPerRow: 0 }) && 'error' in opts({ maxPerRow: 11 }))
check('unknown engine refused', 'error' in opts({ engine: 'firecrawl' }))

// --- the plan ------------------------------------------------------------------
const catalog = {
  prices: { exa: { auto: 0.007, fast: 0.007, deep: 0.012 }, parallel: { turbo: 0.001, fast: 0.001, basic: 0.005, advanced: 0.005 }, perplexity: { '': 0.005 } },
  nativeModels: new Set(['openai/gpt-6-luna', 'anthropic/claude-sonnet-5', 'meta/muse-spark-1.2']),
}
const plan = (o: object, model: string, cat: any = catalog) => planWebSearch({ engine: 'auto', mode: null, maxPerRow: null, ...o } as any, model, cat)
const luna = plan({}, 'openai/gpt-6-luna') as any
check('auto on a model with its own search: native, priced at the provider list price',
  luna.ok.used === 'native' && luna.ok.engine === 'auto' && luna.ok.pricePerSearch === 0.01 && luna.ok.label === "OpenAI's own search")
check('the note says it is a list price, that it can\'t be limited, and that its words depend on OpenAI',
  luna.ok.note.includes("OpenAI's list price of $0.01 a search") && luna.ok.note.includes("can't be limited per row")
  && luna.ok.note.includes('Search words show up only when OpenAI reports them.'))
check('engines OpenRouter runs carry no such caveat', !(plan({ engine: 'parallel' }, 'x/y') as any).ok.note.includes('Search words show up'))
const switched = plan({ maxPerRow: 2 }, 'openai/gpt-6-luna') as any
check('auto + cap on OpenAI: switched to Exa so the cap holds, and says so',
  switched.ok.switched && switched.ok.engine === 'exa' && switched.ok.used === 'exa' && switched.ok.pricePerSearch === 0.007
  && switched.ok.note.startsWith("OpenAI's own search can't be limited per row") && webSearchSummary(switched.ok).switched === true)
check('a fallback is labelled just "Exa"', switched.ok.label === 'Exa' && switched.ok.note.includes('Searches run on Exa at $0.007 a search'))
check('native + cap on OpenAI: refused', 'error' in plan({ engine: 'native', maxPerRow: 2 }, 'openai/gpt-6-luna'))
const claude = plan({ engine: 'native', maxPerRow: 2 }, 'anthropic/claude-sonnet-5') as any
check('native + cap on Anthropic: kept, the cap holds', claude.ok.used === 'native' && claude.ok.maxPerRow === 2
  && claude.ok.note.includes('Up to 2 searches a row, so at most $0.02 a row in search fees.'))
const noNative = plan({ engine: 'native' }, 'deepseek/deepseek-v4-flash') as any
check('native on a model without its own search: Exa, sent as exa, and says so',
  noNative.ok.used === 'exa' && noNative.ok.engine === 'exa' && noNative.ok.note.includes('no search of its own'))
check('auto on a model without its own search sends exa: the plan is what runs',
  (plan({ maxPerRow: 2 }, 'deepseek/deepseek-v4-flash') as any).ok.engine === 'exa')
const parallel = plan({ engine: 'parallel', mode: 'fast', maxPerRow: 1 }, 'openai/gpt-6-luna') as any
check('parallel fast, cap 1: $0.001 a search, at most $0.001 a row', parallel.ok.used === 'parallel' && parallel.ok.pricePerSearch === 0.001
  && parallel.ok.label === 'Parallel (fast mode)' && parallel.ok.note.includes('Up to 1 search a row, so at most $0.001 a row in search fees.'))
check('turbo mode notes its languages', (plan({ engine: 'parallel', mode: 'turbo' }, 'x/y') as any).ok.note.includes('English and Japanese only'))
const sonarCatalog = { ...catalog, nativeModels: new Set(['perplexity/sonar']) }
check('a Perplexity model\'s own search is priced into its requests',
  (plan({}, 'perplexity/sonar', sonarCatalog) as any).ok.note.includes('Perplexity prices into each request'))
check('a Perplexity model on Exa still searches on its own, and the note says so',
  (plan({ engine: 'exa' }, 'perplexity/sonar', sonarCatalog) as any).ok.note.startsWith('Perplexity models also search on their own'))
check('parallel without a mode bills basic', (plan({ engine: 'parallel' }, 'x/y') as any).ok.pricePerSearch === 0.005)
check('perplexity: $0.005', (plan({ engine: 'perplexity' }, 'x/y') as any).ok.pricePerSearch === 0.005)
check('a :variant model id matches its base', (plan({}, 'openai/gpt-6-luna:online') as any).ok.used === 'native')
check('unknown provider price: null, and the note says so',
  (plan({}, 'meta/muse-spark-1.2') as any).ok.pricePerSearch === null && (plan({}, 'meta/muse-spark-1.2') as any).ok.note.includes("Cubex doesn't know it"))
const offline = { prices: {}, nativeModels: null }
check('catalog unreadable: the docs list decides, fallback prices apply',
  (plan({}, 'openai/gpt-6-luna', offline) as any).ok.used === 'native' && (plan({}, 'openai/gpt-4o-mini', offline) as any).ok.used === 'exa'
  && (plan({ engine: 'parallel', mode: 'turbo' }, 'x/y', offline) as any).ok.pricePerSearch === 0.001)

// The catalog as OpenRouter returned it on 2026-10-05 (trimmed).
const read = parseSearchCatalog({ data: {
  id: 'openrouter:web_search', default_engine: 'native', fallback_engine: 'exa',
  engines: [
    { id: 'native', pricing_source: 'provider', pricing: [] },
    { id: 'exa', pricing_source: 'openrouter', default_mode: 'auto', pricing: [
      { mode: 'auto', unit: 'request', price: '0.007' }, { mode: 'deep', unit: 'request', price: '0.012' },
      { mode: null, unit: 'result', price: '0.001' }] },
    { id: 'parallel', pricing_source: 'openrouter', default_mode: 'basic', pricing: [
      { mode: 'turbo', unit: 'request', price: '0.001' }, { mode: 'basic', unit: 'request', price: '0.005' }] },
    { id: 'perplexity', pricing_source: 'openrouter', default_mode: null, pricing: [{ mode: null, unit: 'request', price: '0.005' }] },
    { id: 'firecrawl', pricing_source: 'byok', pricing: [] },
  ],
  native_support: { endpoint_count: 2, model_count: 2, models: [{ slug: 'openai/gpt-6-luna', providers: ['Azure', 'OpenAI'] }, { slug: 'x-ai/grok-4.7', providers: ['xAI'] }] },
} })
check('catalog: per-search prices by mode, per-result surcharges left out',
  read!.prices.exa!.deep === 0.012 && read!.prices.parallel!.turbo === 0.001 && read!.prices.perplexity![''] === 0.005
  && !('' in read!.prices.exa!) && !('firecrawl' in read!.prices))
check('catalog: the models with their own search', read!.nativeModels!.has('openai/gpt-6-luna') && !read!.nativeModels!.has('deepseek/deepseek-v4-flash'))
check('catalog: an unexpected body reads as nothing', parseSearchCatalog({ error: { code: 401 } }) === null)
check('catalog: an empty model list reads as unknown, not as "none search natively"',
  parseSearchCatalog({ data: { engines: [], native_support: { models: [{ providers: ['x'] }] } } })!.nativeModels === null)

// --- the Responses adapter -------------------------------------------------------
const search = (query: string, sources?: string[]) => ({
  type: 'openrouter:web_search', status: 'completed',
  action: { type: 'search', query, ...(sources ? { sources: sources.map(url => ({ type: 'url', url })) } : {}) },
})
const message = (text: string, annotations: object[] = []) =>
  ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations }] })
const reasoning = { type: 'reasoning', status: 'completed', content: [{ type: 'reasoning_text', text: 'thinking' }] }
// Recorded: max_uses 1, the model tried three searches; only the first ran.
const capped = {
  status: 'completed',
  output: [reasoning, search('Stripe CEO 2025', ['https://techcrunch.com/a', 'https://businessinsider.com/b']), search('Stripe headquarters city'),
    reasoning, search('Stripe headquarters San Francisco'), reasoning,
    message('Patrick Collison is the CEO of Stripe, headquartered in San Francisco.', [
      { type: 'url_citation', url: 'https://techcrunch.com/a', title: 'TechCrunch', content: 'PATRICK COLLISON', start_index: 0, end_index: 0 }])],
  usage: { input_tokens: 6945, output_tokens: 420, cost: 0.00174595, server_tool_use_details: { web_search_requests: 3 } },
}
const c1 = completionFromResponse(capped)
check('answer = the message after the last tool call', extractCompletionText(c1) === 'Patrick Collison is the CEO of Stripe, headquartered in San Francisco.')
check('Responses citations read like chat ones', JSON.stringify(citationsFromCompletion(c1).map(c => c.url)) === '["https://techcrunch.com/a"]')
check('usage: tokens and cost', JSON.stringify(usageOf(c1)) === JSON.stringify({ promptTokens: 6945, completionTokens: 420, costUsd: 0.00174595 }))
const log1 = searchLogFromResponse(capped, { cap: 1, maxTotalResults: 5 })
check('cap 1: of three calls one ran (the count OpenRouter billed, not the 3 it reported)', log1.searches === 1
  && JSON.stringify(log1.queries.map(q => q.ran)) === '[true,false,false]' && log1.queries[2].query === 'Stripe headquarters San Francisco')
// Recorded: a search that ran and found nothing has no sources either.
const empty = { status: 'completed', output: [search('qzxv-nonexistent-site-81723.com'), message('Nothing there.')] }
check('a search that found nothing still ran', searchLogFromResponse(empty, { cap: 2, maxTotalResults: 10 }).searches === 1)
const five = ['https://1', 'https://2', 'https://3', 'https://4', 'https://5']
const many = { status: 'completed', output: [search('a', five), search('b', five), search('c'), message('x')] }
check('no cap: the result limit stops the third search', searchLogFromResponse(many, { cap: null, maxTotalResults: 10 }).searches === 2)
check('a model\'s own search: every call ran', searchLogFromResponse(many, { cap: null, maxTotalResults: null }).searches === 3)
const pageOpen = { status: 'completed', output: [{ type: 'web_search_call', action: { type: 'open_page', url: 'https://x' } }, { type: 'web_search_call', action: { type: 'search', query: 'q' } }, message('x')] }
check('OpenAI page opens are not searches', searchLogFromResponse(pageOpen, { cap: null, maxTotalResults: null }).searches === 1)
const chatter = { status: 'completed', output: [message('Let me look that up.'), search('q', ['https://a']), message('The answer.')] }
check('text before a search is not the answer', extractCompletionText(completionFromResponse(chatter)) === 'The answer.')
const cut = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [reasoning], usage: { input_tokens: 10, output_tokens: 16, cost: 0.00004 } }
check('cut off at the token limit: the token-limit error', throws(() => extractCompletionText(completionFromResponse(cut)), 'output token limit'))
check('a cut-off answer still reports its cost', usageOf(completionFromResponse(cut)).costUsd === 0.00004)
const refused = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No.' }] }] }
check('a refusal reads as one', throws(() => extractCompletionText(completionFromResponse(refused)), 'Model refused to answer: No.'))
check('a failed response gives its message, and still reads its usage',
  responseError({ status: 'failed', error: { message: 'Provider down' } }) === 'Provider down'
  && usageOf(completionFromResponse({ status: 'failed', output: null, usage: { cost: 0.001 } })).costUsd === 0.001)
const preamble = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
  output: [message('I will look up the CEO of Stripe.'), search('stripe ceo', ['https://a']), reasoning] }
check('text from before a search is never saved as the answer', throws(() => extractCompletionText(completionFromResponse(preamble)), 'output token limit'))
const endsOnTool = { status: 'completed', output: [message('Let me check.'), search('q', ['https://a'])] }
check('a response that ends on a tool call has no answer', throws(() => extractCompletionText(completionFromResponse(endsOnTool)), 'empty response'))
check('an answer split over two messages keeps both parts', extractCompletionText(completionFromResponse(
  { status: 'completed', output: [search('q'), message('Part one.'), message('Part two.')] })) === 'Part one.\nPart two.')
const twice = { choices: [{ message: { annotations: [
  { type: 'url_citation', url_citation: { url: 'https://a.com/x', title: 'A' } },
  { type: 'url_citation', url_citation: { url: 'https://a.com/x/', title: 'A again' } },
  { type: 'url_citation', url_citation: { url: 'https://b.com', title: 'B' } }] } }] }
check('a page cited twice counts once', JSON.stringify(citationsFromCompletion(twice).map(c => c.title)) === '["A","B"]')
check('a 400 naming temperature, in the message or the provider detail', refusesTemperature({ status: 400, message: "400 Unsupported parameter: 'temperature'" })
  && refusesTemperature({ status: 400, message: '400 Provider returned error', error: { metadata: { raw: '{"error":{"param":"temperature"}}' } } })
  && !refusesTemperature({ status: 400, message: '400 Provider returned error', error: { metadata: { raw: 'bad tools' } } })
  && !refusesTemperature({ status: 500, message: 'temperature' }))
check('malformed usage is null, never a failure', JSON.stringify(usageOf({ usage: { prompt_tokens: 'x', cost: -1 } })) === JSON.stringify({ promptTokens: null, completionTokens: null, costUsd: null }))

// --- the "(Data)" cell ----------------------------------------------------------
check('rows from before searches were logged keep the old cell', aiDataCellSummary([{ title: 'A' }, { title: 'B' }]) === '📊 Searched 2 sources: A, B')
check('no searches logged: says none were reported, never "didn\'t search"',
  aiDataCellSummary([], 'Searched', { queries: [], costUsd: 0.0003 }) === '📊 $0.0003 · No searches reported')
const four = ['one', 'two', 'three', 'four'].map(query => ({ query, ran: true }))
check('more than three searches: three shown',
  aiDataCellSummary([], 'Searched', { queries: four, costUsd: null }) === '📊 4 searches: "one", "two", "three" +1 more')
check('long search words are shortened', aiDataCellSummary([], 'Searched', { queries: [{ query: 'x'.repeat(80), ran: true }], costUsd: null }).includes(`"${'x'.repeat(60)}…"`))
check('refused calls are left out of the count', aiDataCellSummary([], 'Searched', { queries: [{ query: 'a', ran: true }, { query: 'b', ran: false }], costUsd: null }) === '📊 1 search: "a"')
check('fetch-only row with a cost', aiDataCellSummary([], 'Read', { queries: null, costUsd: 0.0012 }) === '📊 $0.0012 · No sources')
check('row costs read cleanly', formatRowCost(0) === '$0' && formatRowCost(0.00004) === '<$0.0001'
  && formatRowCost(0.0017709) === '$0.0018' && formatRowCost(1.234) === '$1.23')

// --- what a row sends --------------------------------------------------------------
const toolOf = (s: any) => (buildWebTools('x', {}, { search: s, fetch: false })[0] as any).parameters
check('an older run sends exactly what it always did',
  JSON.stringify(toolOf({ engine: null, used: null, mode: null, maxPerRow: null })) === '{"max_results":5,"max_total_results":10}')
check('engine, mode and cap go on the tool; the result limit follows the cap',
  JSON.stringify(toolOf({ engine: 'parallel', used: 'parallel', mode: 'fast', maxPerRow: 1 }))
    === '{"max_results":5,"max_total_results":5,"engine":"parallel","mode":"fast","max_uses":1}')
check('replay: OpenRouter engines enforce cap and result limit', JSON.stringify(searchReplayFor({ engine: 'exa', used: 'exa', mode: null, maxPerRow: null })) === '{"cap":null,"maxTotalResults":10}')
const capOne = { engine: 'parallel' as const, used: 'parallel' as const, mode: 'fast', maxPerRow: 1 }
check('a capped row gets a tool-call budget: cap + datetime + one refused ask', toolCallBudget(capOne, false) === 3)
check('with web fetch, room for page reads too', toolCallBudget({ ...capOne, maxPerRow: 2 }, true) === 9)
check('no cap: OpenRouter\'s default budget', toolCallBudget({ ...capOne, maxPerRow: null }, false) === null && toolCallBudget(null, true) === null)
check('replay: a model\'s own search is not policed', JSON.stringify(searchReplayFor({ engine: 'auto', used: 'native', mode: null, maxPerRow: null })) === '{"cap":null,"maxTotalResults":null}')

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall web-search-controls checks passed')
