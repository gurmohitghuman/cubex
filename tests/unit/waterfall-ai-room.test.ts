// A waterfall's AI step sends an AI column's max_tokens (lib/constants-ai.ts aiMaxTokens), so a model that thinks
// before it answers has room to answer: at 1,000 such models spent it all thinking and came back with no answer.
// Through the step's real call (services/waterfall-step-ai.ts) against a stand-in for OpenRouter on 127.0.0.1, and
// its price (services/waterfall-ai-price.ts), whose ceiling is one call at that many output tokens, priced as an AI
// column's hold is. The run keeps what it priced (BuiltAi.maxTokens); a run started before sends 1,000 on resume.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import assert from 'node:assert/strict'
import OpenAI from 'openai'
import { v4 as uuid } from 'uuid'
import { passed } from './ends-on-its-own'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

const PROMPT_PRICE = 0.000001, OUTPUT_PRICE = 0.00001, REASONING_PRICE = 0.00002, REQUEST_FEE = 0.001
type Params = { allowed_domains?: string[]; max_uses?: number; max_content_tokens?: number }
type Tool = { type: string; parameters?: Params }
const bodies: Array<{ max_tokens?: number; messages: unknown[]; tools?: Tool[] }> = []
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url?.endsWith('/models')) {
      res.end(JSON.stringify({ data: [{ id: 'test/model', name: 'Test', context_length: 100_000,
        pricing: { prompt: String(PROMPT_PRICE), completion: String(OUTPUT_PRICE) },
        supported_parameters: ['max_tokens', 'temperature'] }, { id: 'test/thinker', name: 'Thinker',
        context_length: 100_000, supported_parameters: ['max_tokens', 'reasoning'], pricing: {
          prompt: String(PROMPT_PRICE), completion: String(OUTPUT_PRICE),
          internal_reasoning: String(REASONING_PRICE), request: String(REQUEST_FEE) } }] }))
      return
    }
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.end(JSON.stringify({
      id: 'gen-1', object: 'chat.completion', created: 0, model: 'test/model',
      choices: [{ index: 0, message: { role: 'assistant', content: '{"value": "jane@acme.com"}' },
        finish_reason: 'stop' }],
      usage: { prompt_tokens: 40, completion_tokens: 900, total_tokens: 940, cost: 0.0091 },
    }))
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
process.env.OPENROUTER_BASE_URL = base

const { runMigrations } = await import('../../server/src/db/migrate')
const { aiMaxTokens, AI_MIN_OUTPUT_TOKENS, WATERFALL_AI_LEGACY_MAX_TOKENS } =
  await import('../../server/src/lib/constants')
const { aiStep } = await import('../../server/src/services/waterfall-step-ai')
const { priceAiStep } = await import('../../server/src/services/waterfall-ai-price')
runMigrations()
console.warn = () => {}

const w = { v: 1, resultType: 'email', inputs: [{ key: 'name', label: 'Name' }, { key: 'domain', label: 'Domain' }],
  steps: [], hideStepColumns: false, maxCostPerRowUsd: 1, tregCapPerRowUsd: 0, spendLimitUsd: null } as never
const prompt = 'Find the work email of /name at /domain'
const built = { kind: 'ai' as const, model: 'test/model', search: null, capUsd: 1, lowUsd: 0, highUsd: 1 }
const result = await aiStep({
  w, choices: { kind: 'ai', prompt, model: 'test/model', webSearch: false },
  built: { ...built, maxTokens: aiMaxTokens(null) },
  inputs: { name: 'Jane Doe', domain: 'acme.com' },
  client: new OpenAI({ apiKey: 'sk-or-test', baseURL: base }),
  signal: new AbortController().signal, stopped: () => false, halt: () => { throw new Error('no halt expected') },
})
assert.equal(bodies.length, 1)
assert.equal(bodies[0].tools, undefined, 'no web tools unless asked')
assert.equal(bodies[0].max_tokens, aiMaxTokens(null))
assert.ok(aiMaxTokens(null) >= AI_MIN_OUTPUT_TOKENS && AI_MIN_OUTPUT_TOKENS > 1_000)
assert.equal(result.outcome, 'answered')
assert.equal(result.value, 'jane@acme.com')
console.log(`ok   an AI step sends max_tokens ${aiMaxTokens(null)}, as an AI column does, and reads its answer`)

// A run started before the step kept its max_tokens priced 1,000: its resume sends that, so its holds stay true.
await aiStep({
  w, choices: { kind: 'ai', prompt, model: 'test/model', webSearch: false }, built,
  inputs: { name: 'Jane Doe', domain: 'acme.com' }, client: new OpenAI({ apiKey: 'sk-or-test', baseURL: base }),
  signal: new AbortController().signal, stopped: () => false, halt: () => { throw new Error('no halt expected') },
})
assert.equal(bodies[1].max_tokens, WATERFALL_AI_LEGACY_MAX_TOKENS)
console.log('ok   a run started before (no maxTokens kept) sends the 1,000 it priced')

const priced = await priceAiStep(uuid(), { resultType: 'email' } as never, 'test/model', prompt,
  { search: false, fetch: false },  [{ name: 'Jane Doe', domain: 'acme.com' }])
assert.ok('ok' in priced, JSON.stringify(priced))
const p = (priced as { ok: { capUsd: number; highUsd: number; priced: boolean; maxTokens: number } }).ok
assert.ok(p.priced)
assert.equal(p.maxTokens, aiMaxTokens(null), 'the price says what it priced, for the run to keep')
// One call's ceiling: its input plus every output token it may make.
assert.ok(p.capUsd >= aiMaxTokens(null) * OUTPUT_PRICE, `cap ${p.capUsd}`)
assert.ok(p.capUsd < aiMaxTokens(null) * OUTPUT_PRICE + 1_000 * PROMPT_PRICE, `cap ${p.capUsd}`)
assert.ok(p.highUsd <= p.capUsd)
console.log('ok   its price holds one call at that many output tokens, the estimate stays under it')

// A model that thinks bills its thinking at its reasoning price, and a fee a request: the ceiling counts both.
const thinker = await priceAiStep(uuid(), { resultType: 'email' } as never, 'test/thinker', prompt,
  { search: false, fetch: false }, [{ name: 'Jane Doe', domain: 'acme.com' }])
const t = (thinker as { ok: { capUsd: number } }).ok
assert.ok(t.capUsd >= aiMaxTokens(null) * REASONING_PRICE + REQUEST_FEE, `cap ${t.capUsd}`)
console.log('ok   the ceiling prices output at the dearer of output and reasoning, plus the request fee')

// Page reading (webFetch): the call sends the web fetch tool, kept to the sites in the inputs the prompt names
// (an input it doesn't name gives no site), at most the pages and text its price counts (AI_STEP_FETCH_LIMITS).
const { AI_STEP_FETCH_LIMITS } = await import('../../server/src/services/waterfall-step-ai')
const choices = { kind: 'ai' as const, prompt, model: 'test/model', webSearch: false, webFetch: true }
await aiStep({
  w, choices, built: { ...built, maxTokens: aiMaxTokens(null) },
  inputs: { name: 'Jane Doe', domain: 'acme.com', other: 'elsewhere.example' },
  client: new OpenAI({ apiKey: 'sk-or-test', baseURL: base }),
  signal: new AbortController().signal, stopped: () => false, halt: () => { throw new Error('no halt expected') },
})
const fetchTool = bodies[bodies.length - 1].tools?.find(t => t.type === 'openrouter:web_fetch')
assert.deepEqual(fetchTool?.parameters?.allowed_domains, ['acme.com'])
assert.equal(fetchTool?.parameters?.max_uses, AI_STEP_FETCH_LIMITS.maxPagesPerRow)
assert.equal(fetchTool?.parameters?.max_content_tokens, AI_STEP_FETCH_LIMITS.maxContentTokens)
console.log('ok   with page reading the step reads pages only on its inputs\' sites, at most the pages it prices')

// Its price counts the pages a row may read and their fees, on top of the same call.
const pricedFetch = await priceAiStep(uuid(), { resultType: 'email' } as never, 'test/model', prompt,
  { search: false, fetch: true }, [{ name: 'Jane Doe', domain: 'acme.com' }])
const pf = (pricedFetch as { ok: { capUsd: number; lowUsd: number } }).ok
assert.ok(pf.capUsd > p.capUsd && pf.lowUsd > 0, `${JSON.stringify(pf)} vs ${p.capUsd}`)
console.log('ok   page reading raises the step\'s price by its pages and fees')

// The parser keeps webFetch only when on, so a step saved without it is stored and keyed as before.
const { parseStep } = await import('../../server/src/lib/waterfall/input-steps')
const { settingsKey } = await import('../../server/src/lib/waterfall/keys')
const parsed = (c: Record<string, unknown>) => parseStep({ choices: { kind: 'ai', prompt, ...c } }, 0)
const off = parsed({ webSearch: false }), offExplicit = parsed({ webFetch: false }), on = parsed({ webFetch: true })
assert.ok('ok' in off && 'ok' in offExplicit && 'ok' in on)
const choicesOf = (r: unknown) => (r as { ok: { choices: unknown } }).ok.choices
assert.deepEqual(choicesOf(offExplicit), choicesOf(off))
assert.equal(((on as { ok: { choices: { webFetch?: boolean } } }).ok.choices).webFetch, true)
assert.ok('error' in parsed({ webFetch: 'yes' }))
const step = (c: unknown) => ({ id: 's1', label: null, on: true, requires: [], choices: c, check: null,
  built: { kind: 'ai', model: 'test/model', search: null, capUsd: 1, lowUsd: 0, highUsd: 1 } }) as never
const keyOf = (c: Record<string, unknown>) => settingsKey({ resultType: 'email' } as never,
  step({ kind: 'ai', prompt, model: 'test/model', webSearch: false, ...c }))
assert.equal(keyOf({}), keyOf({ webFetch: false }), 'a step without page reading keeps its key')
assert.notEqual(keyOf({}), keyOf({ webFetch: true }), 'page reading changes what a step answers, so its key')
console.log('ok   webFetch is stored only when on; a step without it keeps its key, one with it gets its own')

// Agents: waterfall_column's web_fetch becomes the step's webFetch, and describe gives it back.
const { agentWaterfallBody } = await import('../../server/src/lib/waterfall/agent-args')
const { agentSetup } = await import('../../server/src/services/waterfall-agent-view')
const body = agentWaterfallBody({ sheet_id: 'x', column_name: 'Work email', result_type: 'email',
  inputs: { full_name: 'Name', domain: 'Website' }, steps: [{ kind: 'ai', prompt, web_fetch: true }] },
null, null, { rowIndexes: null, generation: null })
assert.ok('ok' in body, JSON.stringify(body))
const agentStep = ((body as { ok: { steps: Array<{ choices: Record<string, unknown> }> } }).ok.steps)[0]
assert.equal(agentStep.choices.webFetch, true)
assert.equal(((parseStep(agentStep, 0) as { ok: { choices: { webFetch?: boolean } } }).ok.choices).webFetch, true)
const described = agentSetup({ input: { columnName: 'Work email', resultType: 'email', inputs: [], steps: [
  { id: 's1', label: null, on: true, requires: [], check: null,
    choices: { kind: 'ai', prompt, model: null, webSearch: false, webFetch: true } },
  { id: 's2', label: null, on: true, requires: [], check: null,
    choices: { kind: 'ai', prompt, model: null, webSearch: true } },
] }, columns: { answeredBy: null, steps: [] }, activeRunId: null, autoRun: null } as never, { secrets: false }) as
  { steps: Array<Record<string, unknown>> }
assert.equal(described.steps[0].web_fetch, true)
assert.equal(described.steps[1].web_fetch, false)
console.log('ok   agents set web_fetch on an ai step, and describe gives it back')

server.close()
console.log('waterfall-ai-room: all assertions passed')
passed()
