// Which earlier answer a row may reuse (lib/enrich-reuse-key.ts, pure): the
// key names exactly one lookup (tool, request, a waterfall's route, the email
// loop's settings), only found answers kept whole enough are reusable, and a
// Verified work email row comes back whole with its verdict.
import keyMod from '../../server/src/lib/enrich-reuse-key'
const { reuseKeyOf, reusableAnswer, reusedEmailCells, freshBody, wholeFor, readsRaw, withNotes } =
  keyMod as typeof import('../../server/src/lib/enrich-reuse-key')
type Config = import('../../server/src/lib/enrich-run-config').EnrichRunConfig

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

const config = (over: Record<string, unknown> = {}): Config => ({
  requestConfig: { method: 'POST', url: 'x', headers: {}, body: '{}' }, responseMapping: [],
  enrichment: {
    v: 1, toolId: 'treg.people.email.find', toolName: 'Work email', kind: 'waterfall', preset: null,
    toolSnapshot: { id: 'treg.people.email.find', method: 'POST', inputs: [], identitySets: null, derive: null,
      queryArrayEncoding: null },
    providerNames: {}, route: { prefer: ['kitt', 'tomba'], exclude: ['a', 'b'], stopAtFirst: false },
    cleanDomains: true, fresh: false, maxCostPerRowUsd: 0.05, spendLimitUsd: null,
    rows: { mode: 'all', test: null, where: [] }, email: null, ...over,
  },
} as unknown as Config)
const built = (body: string) => ({
  ok: true as const, method: 'POST', path: '/call/treg.people.email.find', query: '', body, sent: {},
})
const ada = built('{"full_name":"Ada Lovelace","domain":"acme.example"}')
const base = reuseKeyOf(config(), ada)

check('a key is 32 hex characters', /^[0-9a-f]{32}$/.test(base))
check('the same lookup has the same key', reuseKeyOf(config(), built(ada.body)) === base)
check('another input is another lookup', reuseKeyOf(config(), built('{"full_name":"Grace Hopper"}')) !== base)
check('another provider order is another lookup',
  reuseKeyOf(config({ route: { prefer: ['tomba', 'kitt'], exclude: ['a', 'b'], stopAtFirst: false } }), ada) !== base)
check('the skipped providers are a set: their order does not matter',
  reuseKeyOf(config({ route: { prefer: ['kitt', 'tomba'], exclude: ['b', 'a'], stopAtFirst: false } }), ada) === base)
check('stopping at the first find is another lookup',
  reuseKeyOf(config({ route: { prefer: ['kitt', 'tomba'], exclude: ['a', 'b'], stopAtFirst: true } }), ada) !== base)
check('the per-row cap and the run limit do not change the lookup',
  reuseKeyOf(config({ maxCostPerRowUsd: 1, spendLimitUsd: 9 }), ada) === base)
check('another tool is another lookup', reuseKeyOf(config({ toolId: 'treg.people.phone.find' }), ada) !== base)
const loop = (strategy: string) => ({
  strategy, guess: false, pattern: 'first.last', verifyExclude: [], verifyKind: 'waterfall',
  verifyTool: { id: 'treg.people.email.verify', method: 'POST', inputs: [], identitySets: null, derive: null,
    queryArrayEncoding: null },
})
const safest = reuseKeyOf(config({ email: loop('safest') }), ada)
check('a Verified work email row is its own lookup', safest !== base)
check('... and another accept rule is another one', reuseKeyOf(config({ email: loop('wide') }), ada) !== safest)

const cells = (fill: 'all' | 'cubex' | 'none', status: 'completed' | 'failed' = 'completed') => ({
  status, statusCell: '', answer: {}, fill, reason: null,
})
const single = { list: false, routed: false, mapped: true }
const routed = { list: false, routed: true, mapped: true }
check('a found answer is reusable', reusableAnswer({ cells: cells('all'), stored: { a: 1 } }, single))
check('not found is not', !reusableAnswer({ cells: cells('none'), stored: { a: 1 } }, single))
check('a rejected address is not', !reusableAnswer({ cells: cells('cubex'), stored: { a: 1 } }, routed))
check('a failed row is not', !reusableAnswer({ cells: cells('all', 'failed'), stored: { a: 1 } }, single))
check('a row with nothing stored is not', !reusableAnswer({ cells: cells('all'), stored: undefined }, single))
check('a single tool\'s answer cut down to fit is not',
  !reusableAnswer({ cells: cells('all'), stored: { a: 1, $trimmedPaths: ['$.b'] } }, single))
check('a waterfall whose raw part was cut is (its output is whole)',
  reusableAnswer({ cells: cells('all'), stored: { output: {}, raw: {}, $trimmedPaths: ['$.raw.x'] } }, routed))
const list = { list: true, routed: true, mapped: false }
check('a single tool run with no outputs finds nothing to reuse (every answer reads as found)',
  !reusableAnswer({ cells: cells('all'), stored: { a: 1 } }, { ...single, mapped: false }))
check('a list job with results is reusable', reusableAnswer({ cells: cells('none'), stored: {}, items: [1] }, list))
check('a list job without any is not', !reusableAnswer({ cells: cells('none'), stored: {}, items: [] }, list))

const dropped = freshBody({ output: { email: 'a@x' }, _cubex: { found_by: 'Kitt' } })
check('the earlier row\'s notes are dropped', JSON.stringify(dropped) === '{"output":{"email":"a@x"}}')
const from = { run_id: 'r', sheet_id: 's', answered_at: '2026-10-01 10:00:00' }
const email = reusedEmailCells({ output: {}, _cubex: { email: 'ada@acme.example', verdict: 'valid', steps: [] } }, from)
check('a passed address is reused whole: found, every output, the source noted',
  !!email && email.fill === 'all' && email.statusCell.startsWith('✅')
    && (email.answer as { _cubex: { reused_from: unknown } })._cubex.reused_from === from)
check('a row without a verdict is not reused', reusedEmailCells({ _cubex: { email: 'a@x' } }, from) === null)

// Cut and pruned answers: whole for what reads the output, not for what reads the cut part.
const pruned = { trimmedPaths: [], prunedAt: '2026-10-01T00:00:00Z' }
const cut = { trimmedPaths: ['$.raw.sources[3:]'], prunedAt: null }
check('a pruned answer still serves the output', wholeFor(['$.output.email', '$._cubex.found_by'], pruned))
check('... not a column reading its raw part', !wholeFor(['$.output.email', '$.raw.data.title'], pruned))
check('a cut answer serves a path beside the cut', wholeFor(['$.raw.data.title'], cut))
check('... not one into it', !wholeFor(['$.raw.sources[5].url'], cut) && !wholeFor(['$.raw.sources'], cut))
check('reading raw is told apart', readsRaw(['$.raw.x']) && readsRaw(["$['raw'].x"]) && readsRaw(['$..email'])
  && !readsRaw(['$.output.raw_name', '$._cubex.email']))
const noted = withNotes({ output: {}, $fill: 'all' }, pruned) as Record<string, unknown>
check('a reused copy keeps the notes of what its answer lost', noted.$prunedAt === pruned.prunedAt
  && JSON.stringify((withNotes({ $trimmedPaths: ['$.a'] }, cut) as Record<string, unknown>).$trimmedPaths)
    === '["$.a","$.raw.sources[3:]"]')

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall answer reuse key checks passed')
