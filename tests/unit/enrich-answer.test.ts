// The answer panel and "add a field" pure parts: the stored answer's shape
// ($fill, $trimmedPaths, $answer), whether a path reads into a part that wasn't
// kept, the cell a new column gets from a stored result, the steps the panel
// lists, and answer fields surviving recall and the run-start parser.
import fs from 'fs'
import storeMod from '../../server/src/lib/answer-store'
import pathsMod from '../../server/src/lib/answer-paths'
import fieldMod from '../../server/src/lib/answer-field'
import stepsMod from '../../server/src/lib/answer-steps'
import trimMod from '../../server/src/lib/answer-trim'
import recallMod from '../../server/src/lib/enrich-run-recall'
import inputMod from '../../server/src/lib/enrich-run-input'
const { withFill, readStored } = storeMod as typeof import('../../server/src/lib/answer-store')
const { droppedPartFor, droppedLabel, parsePath } = pathsMod as typeof import('../../server/src/lib/answer-paths')
const { enrichmentFieldCell, httpFieldCell } = fieldMod as typeof import('../../server/src/lib/answer-field')
const { callSteps, triedProviders, answerSource, accessOf } =
  stepsMod as typeof import('../../server/src/lib/answer-steps')
const { trimAnswer } = trimMod as typeof import('../../server/src/lib/answer-trim')
const { recallChoices } = recallMod as typeof import('../../server/src/lib/enrich-run-recall')
const { parseEnrichRunInput } = inputMod as typeof import('../../server/src/lib/enrich-run-input')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
const live = (name: string) =>
  JSON.parse(fs.readFileSync(`tests/mock-treg/fixtures/calls/${name}.json`, 'utf8')).response
const hit = live('find-hit').body
const capped = live('find-capped-miss').body

// --- The stored shape ------------------------------------------------------------------
const stored = withFill({ ...hit, _cubex: { outcome: 'hit', found_by: 'QuickEnrich' } }, 'all') as
  Record<string, unknown>
check('an object answer carries $fill', stored.$fill === 'all')
const read = readStored(stored)
check('the panel sees the answer without the notes', !('$fill' in (read.body as object)) && read.fill === 'all')
const list = readStored(JSON.parse(JSON.stringify(withFill([{ domain: 'a.example' }], 'all'))))
check('a list answer sits under $answer and reads back as the list', Array.isArray(list.body) && list.fill === 'all')
const longList = Array.from({ length: 400 }, (_, i) => ({ i, pad: 'z'.repeat(80) }))
const trimmedList = readStored(trimAnswer(longList, false, 2048))
const keptList = trimmedList.body as Array<{ i: number }>
check('a list answer loses its tail, so kept items keep their indexes',
  keptList[0].i === 0 && trimmedList.trimmedPaths[0] === `$[${keptList.length}:]`)
check('older rows: a miss fills nothing, a hit fills all, a rejected email only its own',
  readStored({ ...capped, _cubex: { outcome: 'miss' } }).fill === 'none'
  && readStored({ ...hit, _cubex: { outcome: 'hit' } }).fill === 'all'
  && readStored({ _cubex: { rejected_email: 'a@b.example', steps: [] } }).fill === 'cubex')
check('a pruned answer says when', readStored({ output: {}, $prunedAt: '2026-10-08' }).prunedAt === '2026-10-08')

// --- Paths into parts that weren't kept -------------------------------------------------
check('parses the grammar the drawer emits', parsePath('$.raw.data["first name"][0].x')?.length === 5)
check('refuses what it cannot read', parsePath('$.raw[?(@.x)]') === null)
const T = ['$.raw.sources', '$.raw.items[3:]']
check('a path under a dropped part is caught', droppedPartFor('$.raw.sources[0].url', T, false) === '$.raw.sources')
check('a list tail: index 5 is gone, index 1 is kept',
  droppedPartFor('$.raw.items[5].name', T, false) === '$.raw.items[3:]'
  && droppedPartFor('$.raw.items[1].name', T, false) === null)
check('a sibling is fine', droppedPartFor('$.raw.data.position', T, false) === null)
check('a path above a dropped part is refused too (it would fill short)',
  droppedPartFor('$.raw', T, false) !== null && droppedPartFor('$', T, false) !== null)
check('a wildcard or .. that can reach it counts',
  droppedPartFor('$.raw.*[0]', T, false) !== null && droppedPartFor('$..sources', T, false) !== null)
check('the whole answer dropped covers everything', droppedPartFor('$.anything', ['$'], false) === '$')
check('a pruned answer lost raw only',
  droppedPartFor('$.raw.data.title', [], true) === '$.raw' && droppedPartFor('$.output.email', [], true) === null)
const outlier = readStored(trimAnswer([{ big: 'x'.repeat(2500) }, ...Array.from({ length: 50 }, (_, i) => ({ i }))],
  false, 2048))
const keptOutlier = outlier.body as Array<{ i?: number }>
const nineKb = readStored(trimAnswer(Array.from({ length: 30 }, (_, i) => ({ i, pad: 'p'.repeat(9000) })), false))
check('items that fit on their own are kept from the front, only the tail is cut',
  (nineKb.body as unknown[]).length === 1 && nineKb.trimmedPaths.join() === '$[1:]')
const halfFits = readStored(trimAnswer([{ a: 'a'.repeat(10_000), b: 'b'.repeat(10_000) }, { n: 1 }], false, 16_384))
const halfKept = halfFits.body as Array<Record<string, unknown>>
check('an oversized item keeps what fits of it, in place',
  typeof halfKept[0]?.b === 'string' && !('a' in halfKept[0]) && halfKept[1]?.n === 1
  && halfFits.trimmedPaths.join() === '$[0].a')
check('a list item too big alone loses its big part; the rest keep their place',
  JSON.stringify(keptOutlier[0]) === '{}' && keptOutlier[1]?.i === 0 && keptOutlier.length === 51
  && outlier.trimmedPaths[0] === '$[0].big')
const scalar = readStored(trimAnswer(['x'.repeat(3000), 'small'], false, 2048))
check('an oversized plain value turns to null in place', (scalar.body as unknown[])[0] === null
  && (scalar.body as unknown[])[1] === 'small' && scalar.trimmedPaths[0] === '$[0]')
check('labels read plainly',
  droppedLabel('$.raw.sources') === 'raw.sources' && droppedLabel('$') === 'the whole answer'
  && droppedLabel('$.raw.items[3:]') === 'raw.items from item 4 on')
const real = trimAnswer({ output: {}, _treg: {}, raw: { keep: 1, sources: 'x'.repeat(40_000) } }, true, 4096) as
  Record<string, unknown>
check('the trimmer and the check agree', droppedPartFor('$.raw.sources', readStored(real).trimmedPaths, false) !== null)

// --- The cell a new column gets -----------------------------------------------------------
const row = (body: unknown, fill: 'all' | 'cubex' | 'none', status = 'completed') =>
  ({ status, response_data: JSON.stringify(withFill(body, fill)) })
check('a single tool\'s "not found" still fills a new field from its answer',
  enrichmentFieldCell(row({ company: { name: 'Acme' } }, 'none'), '$.company.name', true) === 'Acme'
  && enrichmentFieldCell(row({ company: { name: 'Acme' } }, 'none'), '$.company.name') === null)
check('a found row fills from the answer',
  enrichmentFieldCell(row(hit, 'all'), '$.raw.data.title') === 'Head of Research')
check('a not-found row stays empty', enrichmentFieldCell(row(hit, 'none'), '$.raw.data.title') === null)
check('a rejected email fills only Cubex columns',
  enrichmentFieldCell(row({ _cubex: { checked_by: 'Kitt' }, raw: { a: 1 } }, 'cubex'), '$._cubex.checked_by') === 'Kitt'
  && enrichmentFieldCell(row({ _cubex: {}, raw: { a: 1 } }, 'cubex'), '$.raw.a') === null)
check('a failed or answerless row stays empty',
  enrichmentFieldCell({ status: 'failed', response_data: null }, '$.x') === null
  && enrichmentFieldCell({ status: 'completed', response_data: null }, '$.x') === null)
check('an object value is written as JSON text',
  enrichmentFieldCell(row({ o: { a: 1 } }, 'all'), '$.o') === '{"a":1}')
check('a list answer reads by its own paths',
  enrichmentFieldCell(row([{ d: 'a.example' }], 'all'), '$[0].d') === 'a.example')
check('HTTP: value, no data, error',
  httpFieldCell({ status: 'completed', response_data: '{"a":{"b":"x"}}' }, '$.a.b') === 'x'
  && httpFieldCell({ status: 'completed', response_data: '{"a":{}}' }, '$.a.b') === '⏭️ No data'
  && httpFieldCell({ status: 'failed', response_data: null }, '$.a') === '❌ Error')

// --- Steps ------------------------------------------------------------------------------
const names = { quickenrich: 'QuickEnrich', trykitt: 'Kitt' }
const ledgerRow = (attempt: string, over = {}) => ({
  attempt, tool_id: 'treg.people.email.find', call_id: `c-${attempt}`, cost_micro: 1500, original_cost_micro: null,
  http_status: 200, treg_error: null, served_by: 'trykitt.people.email.verify', served_via: null, tier: 'platform',
  cache_hit: 0, replay: 0, created_at: '2026-10-08 10:00:00', ...over,
})
const emailAnswer = {
  ...hit, _cubex: { email: 'ada@acme.example', steps: [
    { attempt: 'g1', email: 'ada.lovelace@acme.example', verdict: 'invalid', word: 'invalid', checked_by: 'Kitt' },
    { attempt: 'f1', email: 'ada@acme.example', outcome: 'hit', already_checked: 'invalid' },
  ] },
}
const replayed = ledgerRow('f1.2', { replay: 1, cost_micro: 0, original_cost_micro: 4834 })
const steps = callSteps([ledgerRow('g1'), replayed], emailAnswer, names)
check('a guess step joins its note',
  steps[0].step === 'guess' && steps[0].verdict === 'invalid' && steps[0].servedBy === 'Kitt')
check('a renewed key is the same find, a replay keeps its first charge',
  steps[1].step === 'find' && steps[1].email === 'ada@acme.example' && steps[1].replay
  && steps[1].originalCostUsd === 0.004834 && steps[1].alreadyChecked === 'invalid')
const tried = triedProviders(capped, names)
check('treg tried list, with display names and the skip reason',
  tried[0].provider === 'QuickEnrich' && tried[2].outcome === 'skipped' && tried[2].detail === 'would exceed max cost')
check('who found it and on what key',
  answerSource({ ...hit, _cubex: { found_by: 'QuickEnrich' } }).foundBy === 'QuickEnrich'
  && answerSource(hit).access === 'treg')
check('your key, a free route, treg\'s key: from the tier alone',
  accessOf('credential') === 'own' && accessOf('tool') === 'own' && accessOf('anonymous') === 'free'
  && accessOf('platform') === 'treg' && accessOf(null) === null)
check('a single tool answer has no tier: treg does not say', answerSource({ email: 'x' }).access === null)

// --- Answer fields in later runs --------------------------------------------------------------
const config = {
  requestConfig: { method: 'POST', url: 'x', headers: {}, body: '{}' },
  responseMapping: [
    { columnName: 'Email', jsonPath: '$.output.email' }, { columnName: 'Job title', jsonPath: '$.raw.data.title' },
  ],
  previewSize: 5,
  enrichment: {
    v: 1, toolId: 't', toolName: 'T', kind: 'waterfall', preset: null, toolSnapshot: {}, providerNames: {},
    route: { prefer: [], exclude: [], stopAtFirst: false }, cleanDomains: true, fresh: false,
    maxCostPerRowUsd: 0.05, spendLimitUsd: 1, rows: { mode: 'all', status: 'any', test: null, where: [] }, email: null,
    answerFields: ['$.raw.data.title'],
  },
} as never
const recalled = recallChoices(config, 'Status').outputs
check('recall marks a field added from an answer', recalled[1].fromAnswer === true && !recalled[0].fromAnswer)
const parsed = parseEnrichRunInput({
  toolId: 't', columnName: 'S', inputs: { a: { column: 'A' } }, rows: { mode: 'all' },
  outputs: [
    { key: 'x', path: '$.raw.data.title', columnName: 'Job title', fromAnswer: true },
    { key: 'y', path: null, columnName: 'Y', fromAnswer: true },
  ],
})
check('the parser keeps fromAnswer only with a path',
  'ok' in parsed && parsed.ok.outputs[0].fromAnswer === true && !parsed.ok.outputs[1].fromAnswer)

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall answer panel checks passed')
