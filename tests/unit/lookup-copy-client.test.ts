// A lookup column's header tip and Edit lookup's notes in the app (pure): a
// fill that went on through a column that kept changing says so, also once it
// is done, beside its other notes. Value imports are relative (tsx has no "@/").
import assert from 'node:assert/strict'
import { lookupHeaderTip, lookupNotes } from '../../client/src/components/lookup/lookup-copy'
import type { LookupColumnView } from '../../client/src/utils/api/lookup'

const NOTE = '"Name" in "People" kept changing, so rows looked up before its last change may hold older values. '
  + 'Look up every row again to redo them.'
const view = (o: Partial<LookupColumnView>): LookupColumnView => ({
  column: 'Who', sourceColumn: 'Email', otherSheetId: 's', otherSheet: 'People', otherTable: 'T',
  matchColumn: 'Email', match: 'equals', returns: 'value', returnColumns: ['Name'], limit: 10, autoRun: true,
  autoRunNote: null, status: 'done', waiting: null, pausedRun: null, keptChanging: null, filledRows: 3,
  errorRows: 0, firstError: null, error: null, broken: null, ...o,
})

assert.equal(lookupHeaderTip(view({})).text, 'Looks up Email in People › Email')
assert.equal(lookupHeaderTip(view({ keptChanging: NOTE })).text, `Looks up Email in People › Email · ${NOTE}`)
assert.equal(lookupHeaderTip(view({ status: 'filling', keptChanging: NOTE })).text,
  `Looks up Email in People › Email · Looking up now · ${NOTE}`)
assert.deepEqual(lookupNotes(view({})), [])
assert.deepEqual(lookupNotes(view({ keptChanging: NOTE, autoRunNote: 'Paused.' })),
  [NOTE, 'Auto-run is paused: Paused.'])
console.log('All lookup-copy-client assertions passed.')
