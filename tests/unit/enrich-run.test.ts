// The enrichment run engine's pure parts: treg's response headers and the
// headers Cubex sends, route headers (Exclude per provider), what an answer
// means for the cells, the seeding predicate, the email guess, the run-start
// parser and the answer trimmer. Pure: no network, no DB.
import fs from 'fs'
import metaMod from '../../server/src/lib/treg-meta'
import callMod from '../../server/src/lib/treg-call'
import cfgMod from '../../server/src/lib/enrich-run-config'
import outMod from '../../server/src/lib/enrich-outcome'
import cellsMod from '../../server/src/lib/enrich-cells'
import seedMod from '../../server/src/lib/enrich-seed'
import ruleMod from '../../server/src/lib/run-condition'
import guessMod from '../../server/src/lib/enrich-email-guess'
import inputMod from '../../server/src/lib/enrich-run-input'
import trimMod from '../../server/src/lib/answer-trim'
import toolMod from '../../server/src/lib/enrich-tool'
import estMod from '../../server/src/lib/enrich-estimate'
const { readTregMeta } = metaMod as typeof import('../../server/src/lib/treg-meta')
const { tregCallHeaders } = callMod as typeof import('../../server/src/lib/treg-call')
const { routeFor, requestToolOf, CUBEX_PATHS, enrichConcurrency } =
  cfgMod as typeof import('../../server/src/lib/enrich-run-config')
const { answerCells, verdictCells, waterfallOutcome } = outMod as typeof import('../../server/src/lib/enrich-outcome')
const { enrichCellValues } = cellsMod as typeof import('../../server/src/lib/enrich-cells')
const { seedVerdict } = seedMod as typeof import('../../server/src/lib/enrich-seed')
const { checkRule } = ruleMod as typeof import('../../server/src/lib/run-condition')
const { guessEmail, guessParts } = guessMod as typeof import('../../server/src/lib/enrich-email-guess')
const { parseEnrichRunInput } = inputMod as typeof import('../../server/src/lib/enrich-run-input')
const { trimAnswer } = trimMod as typeof import('../../server/src/lib/answer-trim')
const { normalizeTool } = toolMod as typeof import('../../server/src/lib/enrich-tool')
const { limitReached } = estMod as typeof import('../../server/src/lib/enrich-estimate')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
const read = (rel: string) => JSON.parse(fs.readFileSync(`tests/mock-treg/fixtures/${rel}`, 'utf8'))
const live = (name: string) => read(`calls/${name}.json`).response

// --- treg's headers ------------------------------------------------------------
const hit = live('find-hit'), replay = live('find-replay'), capped = live('find-capped-miss')
const mh = readTregMeta(hit.headers)
check('a hit: cost, call id, served by, outcome', mh.costMicro === 4834 && mh.callId === 'c0ffee0000000000000000000000001d' && mh.servedBy === 'quickenrich.people.email.find' && mh.routeOutcome === 'hit')
const mr = readTregMeta(replay.headers)
check('a replay costs 0 and echoes the first charge', mr.costMicro === 0 && mr.originalCostMicro === 4834 && mr.replay)
check('a capped miss is read as capped', readTregMeta(capped.headers).routeCapped && readTregMeta(capped.headers).providersTried.length === 11)
check('treg refusals carry X-Treg-Error', readTregMeta(live('call-bad-key').headers).tregError)
check('an unmetered answer has no cost (not 0)', readTregMeta({ 'x-treg-call-id': 'c' }).costMicro === null)
check('a junk cost header is ignored', readTregMeta({ 'x-treg-cost-micro': '12abc' }).costMicro === null)

const req = { method: 'POST', path: '/call/treg.people.email.find', query: '', body: '{}', idempotencyKey: 'cbx1:k', routed: true,
  maxCostUsd: 0.1034, prefer: ['hunter'], exclude: ['wiza'], stopAtFirst: true, fresh: true }
const h = tregCallHeaders('treg_secret', req)
check('never Authorization', !Object.keys(h).some(k => k.toLowerCase() === 'authorization'))
check('the key goes in X-Treg-Token only', h['X-Treg-Token'] === 'treg_secret' && Object.values(h).filter(v => v === 'treg_secret').length === 1)
check('max cost has 6 decimals', h['X-Treg-Route-Max-Cost'] === '0.103400')
check('route headers on a waterfall', h['X-Treg-Route-Prefer'] === 'hunter' && h['X-Treg-Route-Exclude'] === 'wiza' && h['X-Treg-Route-Waterfall'] === '0')
check('fresh data skips the archive', h['Cache-Control'] === 'no-cache')
check('Idempotency-Key and attribution', h['Idempotency-Key'] === 'cbx1:k' && h['X-Treg-Client'] === 'cubex')
const single = tregCallHeaders('t', { ...req, routed: false, fresh: false, maxCostUsd: null, body: null })
check('no route headers, cap or content type on a bodiless single tool', !('X-Treg-Route-Prefer' in single) && !('X-Treg-Route-Max-Cost' in single) && !('Content-Type' in single))
check('the firewall retry says base64', tregCallHeaders('t', req, true)['X-Treg-Body-Encoding'] === 'base64')
// That uncapped call can still be billed, so the run stops on what treg charged.
check('no per-row cap: a limit is reached only once real spend reaches it',
  !limitReached(1, 0.99, null) && limitReached(1, 1, null) && limitReached(1, 1.2, null)
    && !limitReached(null, 5, null))
check('a per-row cap: a limit is reached once one more row could pass it',
  limitReached(1, 0.95, 0.1) && !limitReached(1, 0.9, 0.1) && !limitReached(1, 5, 0))

// --- Route headers -------------------------------------------------------------
const find = normalizeTool(read('catalog/endpoints/treg.people.email.find.json'))!
find.providers = find.providers!.map(p => ({ ...p, unavailable: p.endpointId.startsWith('wiza.') ? 'async' as const : p.unavailable }))
const r1 = routeFor(find, ['hunter', 'tomba'], ['tomba'], false)
check('Exclude names wiza (async: its only endpoint answers later)', r1.exclude.includes('wiza'))
check('Exclude names a provider switched off', r1.exclude.includes('tomba'))
check('a provider left on is never excluded', !r1.exclude.includes('hunter') && !r1.exclude.includes('quickenrich'))
check('Prefer keeps the order of providers left on', r1.prefer.join(',') === 'hunter')
const tomba2 = routeFor(find, [], [], false)
check('tomba has two endpoints and both run: not excluded', !tomba2.exclude.includes('tomba'))
check('a single tool has no route', routeFor({ ...find, kind: 'single' }, ['x'], [], true).exclude.length === 0)

// --- Answers into cells ----------------------------------------------------------
const names = { quickenrich: 'QuickEnrich', trykitt: 'Kitt AI' }
const mapping = [{ columnName: 'Email', jsonPath: '$.output.email' }, { columnName: 'Found by', jsonPath: CUBEX_PATHS.found_by }]
const found = answerCells({ routed: true, body: hit.body, meta: mh, providerNames: names, mapping, sameAsRow: null })
const fc = enrichCellValues(found, mapping, 'Work email')
check('a hit: Found, the email, and the provider by name', fc['Work email'] === '✅ Found' && fc.Email === 'Ada@acme.example' && fc['Found by'] === 'QuickEnrich')
const firstOnly = live('find-miss-first-only')
const miss = enrichCellValues(answerCells({ routed: true, body: firstOnly.body, meta: readTregMeta(firstOnly.headers), providerNames: names, mapping, sameAsRow: null }), mapping, 'S')
check('a stop-at-first miss names no one in Found by (outcome gates it)', miss.S === '⏭️ Not found' && miss['Found by'] === '' && miss.Email === '')
check('a capped miss: Budget ran out', enrichCellValues(answerCells({ routed: true, body: capped.body, meta: readTregMeta(capped.headers), providerNames: names, mapping, sameAsRow: null }), mapping, 'S').S === '⏭️ Budget ran out')
check('outcome from the body wins over the header', waterfallOutcome({ _treg: { outcome: 'weak' } }, readTregMeta({ 'x-treg-route-outcome': 'miss' })) === 'hit')
const shared = answerCells({ routed: true, body: hit.body, meta: mh, providerNames: names, mapping, sameAsRow: 3 })
check('a shared lookup notes the row it came from', (shared.answer as { _cubex: { same_as_row_index: number } })._cubex.same_as_row_index === 3)
const sm = [{ columnName: 'Result', jsonPath: '$.result' }]
check('a single tool with a value: Found', enrichCellValues(answerCells({ routed: false, body: live('single-paid').body, meta: mh, providerNames: {}, mapping: sm, sameAsRow: null }), sm, 'S').S === '✅ Found')
check('a single tool with nothing picked out: Not found', enrichCellValues(answerCells({ routed: false, body: {}, meta: mh, providerNames: {}, mapping: sm, sameAsRow: null }), sm, 'S').S === '⏭️ Not found')
check('route_max_cost reads as Budget ran out', verdictCells('row_skip', 'Over the per-row budget').statusCell === '⏭️ Budget ran out')
check('a row failure shows a short reason', verdictCells('row_fail', 'x'.repeat(400)).statusCell.length < 130)
check('every column gets a value, never left ⏳', Object.values(enrichCellValues(verdictCells('row_fail', 'x'), mapping, 'S')).every(v => typeof v === 'string'))

// --- Seeding predicate ------------------------------------------------------------
const config = {
  requestConfig: { method: 'POST' as const, url: '', body: JSON.stringify({ full_name: '{{Name}}', domain: '{{Website}}' }) },
  responseMapping: [], previewSize: 5,
  enrichment: { toolSnapshot: requestToolOf(find), cleanDomains: true } as never,
}
const plan = (over = {}) => ({
  statusColumn: null, status: 'any' as const, where: [], rule: null, config, columns: ['Name', 'Website', 'S', 'Size'],
  ...over,
})
check('a row with its inputs runs', seedVerdict({ Name: 'Ada L', Website: 'a.example' }, plan()) === 'run')
check('a row without them is skipped as missing', seedVerdict({ Name: 'Ada L' }, plan()) === 'missing')
check('not enriched: a row with a status is skipped', seedVerdict({ Name: 'A', Website: 'a.example', S: '⏭️ Not found' }, plan({ statusColumn: 'S', status: 'not_enriched' })) === 'skip')
const where = [{ column: 'Size', op: 'gt' as const, value: '50' }]
check('Only run if: passes', seedVerdict({ Name: 'A', Website: 'a.example', Size: '120' }, plan({ where })) === 'run')
const row = (over: Record<string, string>) => ({ Name: 'A', Website: 'a.example', ...over })
check('Only run if: fails, and a non-number never passes gt',
  seedVerdict(row({ Size: 'big' }), plan({ where })) === 'condition')
const rule = checkRule('{{Size}} > 50 OR {{Name}} contains "vip"', ['Name', 'Website', 'S', 'Size']).tree
check('Only run if rule: OR passes', seedVerdict(row({ Name: 'A vip', Size: '3' }), plan({ rule })) === 'run')
check('Only run if rule: fails', seedVerdict(row({ Size: '3' }), plan({ rule })) === 'condition')
check('rule and list both apply', seedVerdict(row({ Name: 'A vip', Size: '3' }), plan({ rule, where })) === 'condition')
const notEnriched = { rule, statusColumn: 'S', status: 'not_enriched' as const }
check('another status is skip, not condition',
  seedVerdict(row({ Size: '3', S: '✅ Found' }), plan(notEnriched)) === 'skip')
check('not enriched takes a row its rule kept out before',
  seedVerdict(row({ Size: '90', S: '⏭️ Condition not met' }), plan(notEnriched)) === 'run')

// --- The free guess ----------------------------------------------------------------
const parts = guessParts({ full_name: 'José María Pérez', domain: 'https://www.Acme.example/x' })
check('names lose accents, the domain is cleaned', parts?.first === 'jose' && parts?.last === 'perez' && parts?.domain === 'acme.example')
check('patterns', guessEmail('first.last', parts!) === 'jose.perez@acme.example' && guessEmail('flast', parts!) === 'jperez@acme.example')
check('no guess without a last name', guessParts({ full_name: 'Cher', domain: 'a.example' }) === null)

// --- Run-start parser ---------------------------------------------------------------
const good = { toolId: 'treg.people.email.find', columnName: 'Email', inputs: { full_name: { column: 'Name' } }, outputs: [], rows: { mode: 'all' } }
check('a plain request parses', 'ok' in parseEnrichRunInput(good))
check('a fixed value with {{ is refused', 'error' in parseEnrichRunInput({ ...good, inputs: { full_name: { value: '{{Name}}' } } }))
check('selected rows need row numbers', 'error' in parseEnrichRunInput({ ...good, rows: { mode: 'selected' } }))
check('a bad tool id is refused', 'error' in parseEnrichRunInput({ ...good, toolId: '../x' }))
check('a zero run limit is refused', 'error' in parseEnrichRunInput({ ...good, spendLimitUsd: 0 }))
const test5 = parseEnrichRunInput({ ...good, rows: { mode: 'filter', test: true } })
check('test runs take 5 rows', 'ok' in test5 && test5.ok.rows.test === 5)

// Rows at once: 1 to 100, the default when not sent; a column's reruns keep it.
const fast = parseEnrichRunInput({ ...good, concurrency: 12 })
check('a concurrency parses', 'ok' in fast && fast.ok.concurrency === 12)
const plain = parseEnrichRunInput(good)
check('no concurrency: the default', 'ok' in plain && plain.ok.concurrency === null)
for (const bad of [0, 101, 1.5, '5']) {
  check(`concurrency ${JSON.stringify(bad)} is refused`, 'error' in parseEnrichRunInput({ ...good, concurrency: bad }))
}
check('the run uses its own concurrency', enrichConcurrency({ batchSize: 12 }) === 12)
check('... the default without one', enrichConcurrency({}) === 20)
check('... never past the HTTP cap', enrichConcurrency({ batchSize: 500 }) === 100)

// --- Stored answers ------------------------------------------------------------------
const big = { output: { email: 'a@b.example' }, _treg: { outcome: 'hit' }, raw: { small: 1, huge: 'x'.repeat(40_000), list: Array.from({ length: 300 }, (_, i) => ({ i, pad: 'y'.repeat(50) })) } }
const kept = trimAnswer(big, true, 4096) as { output: unknown; _treg: unknown; raw: Record<string, unknown>; $trimmedPaths: string[] }
check('output and _treg stay whole', JSON.stringify(kept.output) === JSON.stringify(big.output) && JSON.stringify(kept._treg) === JSON.stringify(big._treg))
check('raw fits the budget and says what went', JSON.stringify(kept.raw).length <= 4096 && kept.$trimmedPaths.includes('$.raw.huge'))
check('small fields survive', kept.raw.small === 1)
check('an answer under the budget is untouched', trimAnswer(hit.body, true) === hit.body)

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall enrichment run checks passed')
