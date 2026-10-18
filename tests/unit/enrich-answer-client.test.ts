// The answer panel's client parts (client/src/components/answer-panel): which
// clicks open it, its words (who found it, cost, steps, parts not kept,
// diagnostics), and "Edit enrichment" keeping fields added from an answer.
// Pure: no DB, no network. Value imports are relative (tsx has no "@/" alias).
import { opensAnswer } from '../../client/src/components/answer-panel/answer-click'
import {
  costLine, diagnostics, droppedText, foundLine, keptNotice, statusLine, stepCost, stepText, triedText,
} from '../../client/src/components/answer-panel/answer-copy'
import { applyRecall } from '../../client/src/components/enrich-modal/recall'
import { runRequest } from '../../client/src/components/enrich-modal/run-request'
import { emptyDraft } from '../../client/src/components/enrich-modal/draft'

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

// --- Clicks -----------------------------------------------------------------------
check('a status or output cell with a value opens it',
  opensAnswer('enrich-status', '✅ Found') && opensAnswer('http-extracted', 'ada@acme.example')
  && opensAnswer('http-master', '✅ Success'))
check('an empty or running cell does not', !opensAnswer('enrich-status', '') && !opensAnswer('enrich-status', '  ')
  && !opensAnswer('http-extracted', '⏳ Processing...'))
check('plain and AI columns keep their own click', !opensAnswer(undefined, 'x') && !opensAnswer('ai-output', 'x'))

// --- Words ------------------------------------------------------------------------
const step = {
  attempt: 'v1', step: 'check' as const, toolId: 'treg.people.email.verify', callId: 'c1', costUsd: 0.0015,
  originalCostUsd: null, httpStatus: 200, tregError: null, servedBy: 'Kitt', servedVia: null, cached: false,
  replay: false, at: '', email: 'ada@acme.example', verdict: 'valid', word: 'valid-risky', outcome: null,
  alreadyChecked: null,
}
const view: any = {
  kind: 'enrichment', column: 'Work email', statusColumn: 'Work email', rowIndex: 3, runId: 'run-1', runAt: '',
  status: 'completed', reason: null, result: [], answer: {}, trimmed: ['$.raw.sources', '$.raw.items[3:]'],
  prunedAt: null, mapping: [],
  enrichment: {
    toolId: 'treg.people.email.find', toolName: 'Verified work email', foundBy: 'QuickEnrich', access: 'treg',
    costUsd: 0.0063, sameLookup: false, reused: null, calls: [step], tried: [],
  },
}
check('found by and on what key', foundLine(view) === "Found by QuickEnrich on treg's key")
check('cost from the treg balance', costLine(view) === '$0.0063 from your treg balance for this row.')
const reusedFrom = (sheetName: string | null) => ({
  ...view, enrichment: { ...view.enrichment, costUsd: 0, calls: [],
    reused: { answeredAt: '2026-10-03 09:00:00', sheetId: sheetName ? 's1' : null, sheetName } },
})
check('a reused answer says when and where it was found, and that it cost nothing',
  costLine(reusedFrom('Leads')) === 'Reused an answer found on 2026-10-03 in Leads: no call, no cost.')
check('... from a sheet deleted since', costLine(reusedFrom(null))?.includes('in a sheet deleted since') === true)
check('nothing charged says so', costLine({ ...view, enrichment: { ...view.enrichment, costUsd: 0 } })
  === 'Nothing was taken from your treg balance for this row.')
check('no cost known says only that', costLine({ ...view, enrichment: { ...view.enrichment, costUsd: null } })
  === 'No cost was reported for this row.')
check('a repeat find says why there was no new check',
  stepText({ ...step, step: 'find', outcome: 'hit', alreadyChecked: 'invalid' }, 'T')
  === 'Find: Kitt found ada@acme.example again, already checked (invalid), so no new check')
check('the status cell as a headline, without its mark',
  statusLine({ ...view, result: [{ column: 'Work email', value: '⏭️ No valid email found' }] })
  === 'No valid email found')
check('a check step', stepText(step, 'Verified work email') === 'Check ada@acme.example: Kitt said valid-risky')
check('a replay keeps its first charge',
  stepCost({ ...step, replay: true, costUsd: 0, originalCostUsd: 0.0048 }) === 'replayed, first charged $0.0048')
check('a refusal names its step and treg code',
  stepText({ ...step, tregError: 'insufficient_balance', httpStatus: 402 }, 'T')
  === 'Check: treg refused the call (insufficient_balance)')
check('a single tool call is named by its tool', stepText({ ...step, step: 'call', tregError: '1' }, 'Company data')
  === 'Company data: treg refused the call')
check('a skipped provider shows why', triedText({
  provider: 'Tomba', outcome: 'skipped', status: null, costUsd: 0, detail: 'would exceed max cost',
}) === 'Tomba: skipped (would exceed max cost)')
check('parts not kept read plainly', droppedText('$.raw.items[3:]') === 'raw.items from item 4 on'
  && droppedText('$') === 'the whole answer')
check('the notice lists them', (keptNotice(view) ?? '').startsWith('Part of this answer was too big to keep: '
  + 'raw.sources, raw.items from item 4 on.'))
check('a pruned answer says when', (keptNotice({ ...view, trimmed: [], prunedAt: '2026-10-08 10:00:00' }) ?? '')
  .includes('removed on 2026-10-08'))
const diag = diagnostics(view, 4)
check('diagnostics: tool, run, row, call ids', diag.includes('Tool: treg.people.email.find')
  && diag.includes('Run: run-1') && diag.includes('Row: 4') && diag.includes('v1 call c1 HTTP 200'))
const words = [foundLine(view), costLine(view), stepText(step, 'x'), keptNotice(view), diag].join(' ')
check('no em dashes in the copy', !words.includes(String.fromCharCode(0x2014)))

// --- Edit keeps fields added from an answer ------------------------------------------
const built = {
  outputs: [{ key: 'email', path: '$.output.email', label: 'Email', enabled: true, columnName: 'Email' }],
}
const recalled = applyRecall(built as never, {
  toolId: 't', toolName: 'T', preset: null, columnName: 'Status', inputs: {}, cleanDomains: true,
  providerOrder: [], skipProviders: [], stopAtFirst: false, email: null,
  outputs: [
    { key: 'email', path: '$.output.email', columnName: 'Email' },
    { key: '$.raw.data.title', path: '$.raw.data.title', columnName: 'Job title', fromAnswer: true },
  ],
  conditions: [], maxCostPerRowUsd: null, fresh: false,
}, 'Status')
const title = {
  outputs: [{ key: 'title', path: '$.output.title', label: 'Title', enabled: true, columnName: 'Title' }],
}
const listedToo = applyRecall(title as never, {
  toolId: 't', toolName: 'T', preset: null, columnName: 'Status', inputs: {}, cleanDomains: true,
  providerOrder: [], skipProviders: [], stopAtFirst: false, email: null,
  outputs: [{ key: '$.output.title', path: '$.output.title', columnName: 'Role', fromAnswer: true }],
  conditions: [], maxCostPerRowUsd: null, fresh: false,
}, 'Status').outputs ?? []
check('a field the tool lists too ticks that output instead of showing twice',
  listedToo.length === 1 && listedToo[0].enabled && listedToo[0].columnName === 'Role'
  && !listedToo[0].fromAnswer)
const email = [{ key: 'email', path: '$.output.email', label: 'Work email', enabled: true, columnName: 'Email' }]
const rawEmail = applyRecall({ outputs: email } as never, {
  toolId: 't', toolName: 'T', preset: 'verified_email', columnName: 'Status', inputs: {}, cleanDomains: true,
  providerOrder: [], skipProviders: [], stopAtFirst: false, email: null,
  outputs: [{ key: '$.output.email', path: '$.output.email', columnName: 'Finder email', fromAnswer: true }],
  conditions: [], maxCostPerRowUsd: null, fresh: false,
}, 'Status').outputs ?? []
check('an answer field on the finder email never becomes the checked Email output',
  !rawEmail[0].enabled && rawEmail[1]?.fromAnswer === true && rawEmail[1].columnName === 'Finder email')
const extra = (recalled.outputs ?? []).find(o => o.fromAnswer)
check('an answer field comes back on, after the tool outputs',
  extra?.columnName === 'Job title' && extra.enabled && extra.label === 'raw.data.title')
const card: any = { id: 't', title: 'T', kind: 'waterfall', price: { usd: 0.01 } }
const req = runRequest({ ...emptyDraft(), card, columnName: 'Status', outputs: recalled.outputs ?? [] },
  { mode: 'all', selectedRows: [], test: false, order: [] })
check('the run sends it marked as from an answer',
  req?.outputs.some(o => o.fromAnswer && o.path === '$.raw.data.title') === true)

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall answer panel client checks passed')
