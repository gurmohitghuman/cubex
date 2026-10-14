// What each provider did in an enrichment run, and the cool-down for one that
// keeps answering 429 (services/enrich-providers.ts), through the real row
// loop against a stubbed treg answering like the recorded verify fixture:
// ContactOut 429, then Kitt answers. The cool-down changes only the exclude
// header, never a row's Idempotency-Key, and never leaves out the last provider.
import fs from 'fs'
import { v4 as uuid } from 'uuid'

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }
// Retry waits in milliseconds, not seconds (read when the modules load, in main).
process.env.ENRICH_PROVIDER_RATE_RETRY_MS = '10'
process.env.ENRICH_PROVIDER_RATE_RETRY_MAX_MS = '40'
process.env.ENRICH_RETRY_MS = '10'

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

const fixture = JSON.parse(fs.readFileSync('tests/mock-treg/fixtures/calls/verify-nobody.json', 'utf8'))
const sent: Array<{ key: string; exclude: string | null; email: string }> = []
let calls = 0
// A treg refusal (X-Treg-Error), billed nothing.
const refuse = (status: number, detail: unknown, callId = `call-${++calls}`) =>
  new Response(JSON.stringify({ detail }), {
    status, headers: { 'content-type': 'application/json', 'x-treg-error': '1', 'x-treg-call-id': callId },
  })
// Lets a test answer some calls itself; null: the recorded waterfall answer.
let special: ((email: string, exclude: string[], key: string) => Response | null) | null = null
globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
  const h = init?.headers as Record<string, string>
  const email = (JSON.parse(String(init?.body)) as { email: string }).email
  sent.push({ key: h['Idempotency-Key'], exclude: h['X-Treg-Route-Exclude'] ?? null, email })
  const excluded = (h['X-Treg-Route-Exclude'] ?? '').split(',')
  const own = special?.(email, excluded, h['Idempotency-Key'])
  if (own) return own
  const tried = fixture.response.body._treg.tried.filter((t: { provider: string }) => !excluded.includes(t.provider))
  const body = { ...fixture.response.body, _treg: { ...fixture.response.body._treg, tried } }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...fixture.response.headers, 'x-treg-call-id': `call-${++calls}` },
  })
}) as typeof fetch

async function main() {
  const { db } = await import('../../server/src/lib/db')
  const { runMigrations } = await import('../../server/src/db/migrate')
  const { saveTregToken } = await import('../../server/src/services/treg-key')
  const { processEnrichmentRun } = await import('../../server/src/services/enrich-runner')
  const { runStep } = await import('../../server/src/services/enrich-step')
  const { excludeWithCooldown, runProviders } = await import('../../server/src/services/enrich-providers')
  const { providerTries } = await import('../../server/src/lib/enrich-provider-tries')
  const { readTregMeta } = await import('../../server/src/lib/treg-meta')
  const { idempotencyKey } = await import('../../server/src/lib/enrich-request')
  const { PLACEHOLDER } = await import('../../server/src/lib/placeholder-cells')
  type Run = import('../../server/src/services/http-runner-status').HTTPRunRow
  type Config = import('../../server/src/lib/enrich-run-config').EnrichRunConfig
  runMigrations()

  // The recorded answer, read: ContactOut's 429 and Kitt's paid hit.
  const tries = providerTries(fixture.response.body, readTregMeta(fixture.response.headers), 200)
  check('a waterfall answer lists each provider it asked', JSON.stringify(tries) === JSON.stringify([
    { provider: 'contactout', outcome: 'error', status: 429, chargedMicro: 0 },
    { provider: 'trykitt', outcome: 'hit', status: 200, chargedMicro: 1500 },
  ]))

  const uid = uuid(), tableId = uuid(), sheetId = uuid(), runId = uuid()
  db.prepare('INSERT INTO users (id,password_hash) VALUES (?,?)').run(uid, 'x')
  db.prepare('INSERT INTO tables (id, user_id, name) VALUES (?,?,?)').run(tableId, uid, 'T')
  saveTregToken(uid, 'treg_test_key')
  const TOOL = {
    id: 'treg.people.email.verify', method: 'POST', identitySets: null, derive: null, queryArrayEncoding: null,
    inputs: [{ name: 'email', in: 'body', type: 'string', required: true }],
  }
  const config = {
    requestConfig: { method: 'POST', url: 'x', headers: {}, body: JSON.stringify({ email: '{{Email}}' }) },
    responseMapping: [{ columnName: 'Status', jsonPath: '$.output.status' }], batchSize: 1,
    enrichment: {
      v: 1, toolId: TOOL.id, toolName: 'Verify email', kind: 'waterfall', preset: null, toolSnapshot: TOOL,
      providerNames: { contactout: 'ContactOut', trykitt: 'Kitt AI' },
      route: { prefer: [], exclude: [], stopAtFirst: false }, cleanDomains: true, fresh: false,
      maxCostPerRowUsd: 0.02, spendLimitUsd: null, rows: { mode: 'all', test: null, where: [] }, email: null,
    },
  }
  const runOn = async (sheet: string, run: string, emails: string[]) => {
    db.prepare('INSERT INTO sheets (id, table_id, user_id, name, column_order) VALUES (?,?,?,?,?)')
      .run(sheet, tableId, uid, `S-${sheet.slice(0, 8)}`, JSON.stringify(['Email', 'Verify', 'Status']))
    const add = db.prepare('INSERT INTO rows (id, sheet_id, user_id, row_index, data) VALUES (?,?,?,?,?)')
    emails.forEach((email, i) => add.run(uuid(), sheet, uid, i, JSON.stringify({ Email: email, Verify: PLACEHOLDER })))
    db.prepare(`INSERT INTO http_runs (id, sheet_id, user_id, config, status, master_column_name, total_rows,
      worker_generation) VALUES (?,?,?,?,'running','Verify',?,1)`)
      .run(run, sheet, uid, JSON.stringify(config), emails.length)
    const r = db.prepare('SELECT * FROM http_runs WHERE id = ?').get(run) as Run
    await processEnrichmentRun(r, JSON.parse(r.config as unknown as string) as Config, 1, null)
    return (db.prepare('SELECT data FROM rows WHERE sheet_id = ? ORDER BY row_index').pluck().all(sheet) as string[])
      .map(d => JSON.parse(d) as Record<string, string>)
  }
  await runOn(sheetId, runId, Array.from({ length: 6 }, (_, i) => `p${i}@acme.example`))

  check('every row was answered', sent.length === 6)
  check('the first three rows asked ContactOut', sent.slice(0, 3).every(s => s.exclude === null))
  check('after three 429s in a row the rest leave it out', sent.slice(3).every(s => s.exclude === 'contactout'))
  // Each row's key is the one its column's own route gives, cool-down or not.
  const keyFor = (i: number) => idempotencyKey(runId, i, 't1', {
    method: 'POST', path: `/call/${encodeURIComponent(TOOL.id)}`, query: '',
    body: JSON.stringify({ email: `p${i}@acme.example` }), prefer: [], exclude: [],
  })
  check('keys never carry the cool-down (a resume replays, never buys again)',
    sent.every((s, i) => s.key === keyFor(i)))

  const providers = runProviders(runId, uid, config.enrichment.providerNames)
  const co = providers.find(p => p.provider === 'ContactOut')
  const kitt = providers.find(p => p.provider === 'Kitt AI')
  check('ContactOut: asked 3 times, 3 rate limits, cooling down',
    co?.tried === 3 && co.rate_limited === 3 && co.errors === 3 && !!co.cooling_down_until && co.cost_usd === 0)
  check('Kitt AI: answered all 6, and what it cost', kitt?.tried === 6 && kitt.hits === 6 && kitt.cost_usd === 0.009)
  check('most asked first', providers[0].provider === 'Kitt AI')

  // Never the last provider treg tried for the tool.
  const ctx = { cooldown: new Map([['t', new Map([['solo', { strikes: 0, until: Date.now() + 60_000 }]])]]) }
  check('a lone provider cooling down is still asked',
    excludeWithCooldown(ctx as never, 't', []) !== undefined
      && (excludeWithCooldown(ctx as never, 't', []) as string[]).length === 0)
  check('another tool is not affected', excludeWithCooldown(ctx as never, 'other', ['x'])?.join() === 'x')

  // A row only ContactOut can take, met while ContactOut cools down: treg finds
  // no provider; asked once more without the cool-down under a new key.
  special = (email, excluded) => (email.startsWith('only') && excluded.includes('contactout')
    ? refuse(422, { error: 'no_route_candidate', message: 'No provider can take these inputs' }) : null)
  sent.length = 0
  const rows = await runOn(uuid(), uuid(), [...['a', 'b', 'c'].map(x => `${x}@acme.example`), 'only@acme.example'])
  const only = sent.filter(x => x.email === 'only@acme.example')
  check('a row the cool-down left with no provider is asked again without it',
    only.length === 2 && only[0].exclude === 'contactout' && only[1].exclude === null
      && only[0].key !== only[1].key && rows[3].Status === 'invalid')

  // treg's shared key busy: asked again under the SAME key, never billed twice.
  let busyLeft = 2
  special = (email) => (email === 'busy@acme.example' && busyLeft-- > 0
    ? refuse(429, { error: 'share_busy', retry_after_s: 0, provider: 'contactout' }) : null)
  sent.length = 0
  const busyRows = await runOn(uuid(), uuid(), ['busy@acme.example'])
  check('share_busy: retried under the same key until it answers',
    sent.length === 3 && new Set(sent.map(x => x.key)).size === 1 && busyRows[0].Status === 'invalid')
  // A refusal treg kept for the key comes back as itself: the row ends at once.
  special = () => refuse(429, { error: 'share_busy', retry_after_s: 0 }, 'kept-call')
  sent.length = 0
  const keptRows = await runOn(uuid(), uuid(), ['kept@acme.example'])
  check('share_busy kept for the key: the row fails, without asking again and again',
    sent.length === 2 && keptRows[0].Verify.includes('stayed busy'))

  // A waterfall where every provider answered 429 (route_failed, charged nothing):
  // treg keeps no such refusal, so the row asks again under the same key.
  const routeFailed = (provider: string, charged = 0, callId?: string) => refuse(502, {
    error: 'route_failed', charged_micro: charged,
    tried: [{ provider, outcome: 'error', status: 429, charged_micro: 0, detail: '{"message":"Too Many Attempts."}' }],
  }, callId)
  let slowLeft = 2
  special = (email) => (email === 'slow@acme.example' && slowLeft-- > 0 ? routeFailed('contactout') : null)
  sent.length = 0
  const slowRun = uuid()
  const slowRows = await runOn(uuid(), slowRun, ['slow@acme.example'])
  check('route_failed on 429s: asked again under the same key until it answers',
    sent.length === 3 && new Set(sent.map(x => x.key)).size === 1 && slowRows[0].Status === 'invalid')
  const slowCo = runProviders(slowRun, uid, config.enrichment.providerNames).find(p => p.provider === 'ContactOut')
  check('every asking is counted: two refusals and the answer, three rate limits',
    slowCo?.tried === 3 && slowCo.rate_limited === 3)
  special = (email) => (email === 'never@acme.example' ? routeFailed('contactout') : null)
  sent.length = 0
  const neverRows = await runOn(uuid(), uuid(), ['never@acme.example'])
  check('route_failed on 429s: five more tries, then the row names the provider and its error',
    sent.length === 6 && neverRows[0].Verify.includes('ContactOut answered 429: Too Many Attempts'))

  // A row's steps share one 429 budget (a verified email's finds and checks):
  // a step after the budget is used fails at its first 429.
  const rateRetries = { left: 2 }
  const stepCtx = {
    runId: slowRun, userId: uid, sheetId, statusColumn: 'Verify', token: 't', autorunId: null,
    signal: new AbortController().signal, stopped: () => false, halt: null, onHalt: () => {},
    unreachableStreak: 0, sameLookup: new Map(), cooldown: new Map(),
  }
  const stepFor = (email: string) => {
    const parts = { method: 'POST', path: `/call/${TOOL.id}`, query: '', body: JSON.stringify({ email }), prefer: [],
      exclude: [] }
    return runStep(stepCtx as never, {
      toolId: TOOL.id, attempt: 't1', rowIndex: 0, rowId: null, parts, rateRetries,
      request: { ...parts, routed: true, maxCostUsd: 0.02, stopAtFirst: false, fresh: false },
    })
  }
  special = () => routeFailed('contactout')
  sent.length = 0
  const firstStep = await stepFor('budget1@acme.example')
  const secondStep = await stepFor('budget2@acme.example')
  check('a row\'s steps share its 429 retries',
    firstStep.kind === 'row_fail' && secondStep.kind === 'row_fail' && rateRetries.left === 0
      && sent.filter(x => x.email === 'budget1@acme.example').length === 3
      && sent.filter(x => x.email === 'budget2@acme.example').length === 1)

  // Met while ContactOut cools down, Kitt's 429 leaves no provider: the row is
  // asked again without the cool-down at once, before any wait.
  const warm = ['d', 'e', 'f'].map(x => `${x}@acme.example`)
  special = (email, excluded) => (email === 'hop@acme.example' && excluded.includes('contactout')
    ? routeFailed('trykitt') : null)
  sent.length = 0
  const hopRows = await runOn(uuid(), uuid(), [...warm, 'hop@acme.example'])
  const hop = sent.filter(x => x.email === 'hop@acme.example')
  check('a cooled-down row whose providers all 429 drops the cool-down before waiting',
    hop.length === 2 && hop[0].exclude === 'contactout' && hop[1].exclude === null && hopRows[3].Status === 'invalid')
  // One that charged something is kept by treg: a new key would buy it again.
  special = (email, excluded) => (email === 'paid@acme.example' && excluded.includes('contactout')
    ? routeFailed('trykitt', 5000, 'paid-call') : null)
  sent.length = 0
  const paidRows = await runOn(uuid(), uuid(), [...warm, 'paid@acme.example'])
  check('a route_failed that charged something is never asked again under a new key',
    sent.filter(x => x.email === 'paid@acme.example').length === 1
      && paidRows[3].Verify.includes('Every provider failed for this row:'))
  special = null

  console.log(failures === 0 ? '\nenrich-providers: all passed' : `\n${failures} FAILURES`)
  if (failures > 0) process.exit(1)
}
main().catch(e => { console.error(e); process.exit(1) })
