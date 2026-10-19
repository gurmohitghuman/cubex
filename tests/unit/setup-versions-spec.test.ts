// Setup versions, the pure parts (lib/setup-versions/): a rename reaches every
// reference in a version (prompts, requests, formulas, sources, rules,
// auto-run) and another sheet's rename reaches its lookups; a version naming a
// deleted column under the new name loses that entry; the diff says what's
// gone, added, changed field by field and filled another way; HTTP columns'
// filled columns aren't part of their setup; equal configs saved in another
// key order are the same; read tokens see no header value, a masked URL and no
// body; the order a restore leaves keeps added columns next to where they are.
import assert from 'node:assert/strict'
import renameMod from '../../server/src/lib/setup-versions/rename'
import diffMod from '../../server/src/lib/setup-versions/diff'
import fieldsMod from '../../server/src/lib/setup-versions/fields'
import specMod from '../../server/src/lib/setup-versions/spec'
const { renameVersionColumn, renameOtherSheetColumn } =
  renameMod as typeof import('../../server/src/lib/setup-versions/rename')
const { diffVersion, mergeOrder } = diffMod as typeof import('../../server/src/lib/setup-versions/diff')
const { fillChanges, fillKey } = fieldsMod as typeof import('../../server/src/lib/setup-versions/fields')
const { columnKinds } = specMod as typeof import('../../server/src/lib/setup-versions/spec')
type Spec = import('../../server/src/lib/setup-versions/spec').VersionSpec

let failures = 0
function check(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) } catch (e) {
    failures++; console.log('FAIL', label, '\n ', (e as Error).stack)
  }
}

const ctx = { reveal: false, sheetName: (id: string) => (id === 'other' ? 'Companies' : null) }
const ai = (prompt: string) => ({
  kind: 'ai' as const, prompt, systemPrompt: null, model: 'm', temperature: 0.7, maxChars: null, concurrency: 5,
  webSearch: false, webFetch: false, outputColumns: null, dataColumn: null, searchEngine: null, searchMode: null,
  maxSearchesPerRow: null, runIf: '{{Company Name}} is not empty',
})
const http = (url: string, extracted = ['Post id']) => ({
  kind: 'http' as const, mode: 'http' as const, allowSecrets: 1, destSheetId: null, extracted,
  config: { requestConfig: { method: 'GET', url, headers: { Authorization: 'Bearer sk-live-123' },
    body: '{"q":"{{Company Name}}"}' },
    responseMapping: [{ jsonPath: '$.id', columnName: 'Post id' }], runIf: null },
})
const base = (): Spec => ({
  v: 1,
  columns: [
    { name: 'Company Name', description: 'Who', fill: null, autoRun: null },
    { name: 'Domain', description: null,
      fill: { kind: 'formula', formula: '{{Company Name}}.toLowerCase()', description: null },
      autoRun: { where: [], runIf: null, dailyCapUsd: null, dailyRowCap: null } },
    { name: 'Fit (Output)', description: null, fill: ai('Is /company_name a fit?'), autoRun: null },
    { name: 'Lookup', description: null, fill: http('https://x.test/{{Company Name}}?key=abcd1234efgh5678'),
      autoRun: { where: [{ column: 'Company Name', op: 'not_empty', value: '' }],
        runIf: '{{Company Name}} is not empty',
        dailyCapUsd: null, dailyRowCap: 100 } },
    { name: 'Post id', description: null, fill: null, autoRun: null },
    { name: 'Match', description: null, fill: { kind: 'lookup', source: 'Company Name', otherSheetId: 'other',
      matchColumn: 'Name', match: 'equals', returns: 'value', returnColumns: ['Size'], limit: 10 }, autoRun: null },
  ],
})

check('a rename reaches the column and every reference to it', () => {
  const s = base()
  assert.equal(renameVersionColumn(s, 'Company Name', 'Company'), true)
  const by = new Map(s.columns.map(c => [c.name, c]))
  assert.ok(by.has('Company') && !by.has('Company Name'))
  assert.equal((by.get('Domain')!.fill as any).formula, '{{Company}}.toLowerCase()')
  assert.equal((by.get('Fit (Output)')!.fill as any).prompt, 'Is /company a fit?')
  assert.equal((by.get('Fit (Output)')!.fill as any).runIf, '{{Company}} is not empty')
  const cfg = (by.get('Lookup')!.fill as any).config
  assert.equal(cfg.requestConfig.url, 'https://x.test/{{Company}}?key=abcd1234efgh5678')
  assert.equal(cfg.requestConfig.body, '{"q":"{{Company}}"}')
  assert.deepEqual(by.get('Lookup')!.autoRun!.where[0].column, 'Company')
  assert.equal(by.get('Lookup')!.autoRun!.runIf, '{{Company}} is not empty')
  assert.equal((by.get('Match')!.fill as any).source, 'Company')
  assert.equal(renameVersionColumn(s, 'Nothing', 'Else'), false)
})

check('renaming onto a name the version keeps for a deleted column drops that entry', () => {
  const s = base()
  s.columns.push({ name: 'Old', description: 'deleted since', fill: null, autoRun: null })
  renameVersionColumn(s, 'Post id', 'Old')
  assert.deepEqual(s.columns.filter(c => c.name === 'Old').map(c => c.description), [null])
  assert.deepEqual((s.columns.find(c => c.name === 'Lookup')!.fill as any).extracted, ['Old'])
  // Not naming the renamed column: the entry stays (the name maps to the column under it now).
  const t = base()
  t.columns.push({ name: 'Gone', description: 'kept', fill: null, autoRun: null })
  renameVersionColumn(t, 'Unknown', 'Gone')
  assert.equal(t.columns.find(c => c.name === 'Gone')?.description, 'kept')
})

check("another sheet's rename reaches lookups, waterfall lookup steps and list enrichments", () => {
  const s = base()
  s.columns.push({ name: 'W', description: null, autoRun: null, fill: { kind: 'http', mode: 'waterfall',
    allowSecrets: 1,
    destSheetId: null, extracted: [], config: { waterfall: { steps: [{ label: 'L', choices: { kind: 'lookup',
      sheetId: 'other', matchColumn: 'Name', returnColumn: 'Size' } }] } } } })
  s.columns.push({ name: 'E', description: null, autoRun: null, fill: { kind: 'http', mode: 'enrichment',
    allowSecrets: 1,
    destSheetId: 'other', extracted: [], config: { enrichment: { list: { fields: [{ columnName: 'Size' }],
      copy: [{ from: 'Company Name', to: 'Size' }] } } } } })
  assert.equal(renameOtherSheetColumn(s, 'other', 'Size', 'Headcount'), true)
  const f = (n: string) => s.columns.find(c => c.name === n)!.fill as any
  assert.deepEqual(f('Match').returnColumns, ['Headcount'])
  assert.equal(f('W').config.waterfall.steps[0].choices.returnColumn, 'Headcount')
  assert.equal(f('E').config.enrichment.list.fields[0].columnName, 'Headcount')
  assert.equal(f('E').config.enrichment.list.copy[0].to, 'Headcount')
  assert.equal(f('E').config.enrichment.list.copy[0].from, 'Company Name')
  assert.equal(renameOtherSheetColumn(s, 'another', 'Name', 'X'), false)
})

check('the diff: gone, added, changed field by field, another kind, unchanged counted', () => {
  const now = base()
  now.columns = now.columns.filter(c => c.name !== 'Domain')
  now.columns.push({ name: 'Notes', description: null, fill: null, autoRun: null })
  now.columns.find(c => c.name === 'Fit (Output)')!.fill = ai('Is /company_name a good fit?')
  now.columns.find(c => c.name === 'Lookup')!.autoRun = null
  now.columns.find(c => c.name === 'Company Name')!.description = 'Changed'
  now.columns.find(c => c.name === 'Match')!.fill = { kind: 'formula', formula: '1', description: null }
  const d = diffVersion(base(), now, ctx)
  const by = new Map(d.columns.map(c => [c.column, c]))
  assert.equal(by.get('Domain')!.change, 'missing')
  assert.equal(by.get('Notes')!.change, 'added')
  assert.deepEqual(by.get('Fit (Output)')!.fields.map(f => f.field), ['Prompt'])
  assert.deepEqual(by.get('Lookup')!.fields, [{ field: 'Auto-run', now: 'off',
    version: 'on, only if {{Company Name}} is not empty, only if Company Name is not empty, up to 100 rows a day' }])
  assert.deepEqual(by.get('Company Name')!.fields, [{ field: 'Description', version: 'Who', now: 'Changed' }])
  assert.equal(by.get('Match')!.change, 'kind')
  assert.equal(by.get('Match')!.nowKind, 'formula')
  assert.equal(d.unchanged, 1) // Post id
  // A gone column coming back takes its place: that alone isn't a reorder.
  assert.equal(d.order.changed, false)
  assert.equal(diffVersion(base(), base(), ctx).columns.length, 0)
  const moved = base()
  moved.columns.reverse()
  assert.equal(diffVersion(base(), moved, ctx).order.changed, true)
})

check("an HTTP column's filled columns aren't its setup; key order doesn't matter", () => {
  const a = http('https://x.test/a'), b = http('https://x.test/a', ['Post id', 'Old field'])
  assert.equal(fillKey(a), fillKey(b))
  const c = { ...a,
    config: { runIf: null, responseMapping: a.config.responseMapping, requestConfig: a.config.requestConfig } }
  assert.equal(fillKey(a), fillKey(c))
  assert.deepEqual(fillChanges(a, b, ctx), [])
})

check('what a read token sees: masked URL, header names, no body; the app sees the body', () => {
  const a = http('https://x.test/{{Company Name}}?key=abcd1234efgh5678')
  const b = http('https://y.test/{{Company Name}}?key=zzzz1234efgh5678')
  b.config.requestConfig.headers = { Authorization: 'Bearer sk-live-999' }
  b.config.requestConfig.body = '{"q":"secret-body"}'
  const out = fillChanges(a, b, ctx)
  const text = JSON.stringify(out)
  for (const hidden of ['sk-live-123', 'sk-live-999', 'abcd1234efgh5678', 'zzzz1234efgh5678', 'secret-body']) {
    assert.ok(!text.includes(hidden), `${hidden} leaked: ${text}`)
  }
  assert.deepEqual(out.map(f => f.field), ['URL', 'Headers', 'Body'])
  assert.ok(JSON.stringify(fillChanges(a, b, { ...ctx, reveal: true })).includes('secret-body'))
})

check('the order a restore leaves', () => {
  assert.deepEqual(mergeOrder(['A', 'B', 'C'], ['C', 'X', 'A', 'Y', 'B']), ['A', 'Y', 'B', 'C', 'X'])
  assert.deepEqual(mergeOrder(['A', 'B'], ['X', 'B', 'A']), ['X', 'A', 'B'])
  assert.deepEqual(mergeOrder(['A', 'Gone', 'B'], ['A', 'B']), ['A', 'Gone', 'B'])
})

check("a column's kind, and the column filling another", () => {
  const k = columnKinds(base())
  assert.deepEqual(k.get('Post id'), { kind: 'made', by: 'Lookup' })
  assert.deepEqual(k.get('Lookup'), { kind: 'http', by: null })
  assert.deepEqual(k.get('Company Name'), { kind: 'plain', by: null })
})

if (failures) { console.error(`${failures} failed`); process.exit(1) }
console.log('setup-versions-spec: all passed')
