// The AI column dialog's name check (client/src/components/ai-modal/useColumnNameValidation.ts).
// Editing a column used to report its own name as taken: the check looked the
// edited name up in a one-shot localStorage payload the dialog had already
// consumed on open. Now the name being edited is passed in.
// Pure: no DB, no network. Value imports are relative (tsx has no "@/" alias).
import { columnNameError, NAME_TAKEN } from '../../client/src/components/ai-modal/useColumnNameValidation'

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}

const cols = [{ name: 'val' }, { name: 'Summary' }, { name: 'Summary (Output)' }]

check('a new name is fine', columnNameError('Industry', cols, null) === '')
check('an empty name shows nothing yet', columnNameError('   ', cols, null) === '')
check('a taken name is flagged (case-insensitive)', columnNameError('summary', cols, null) === NAME_TAKEN)
check('editing that column: its own name is fine', columnNameError('Summary', cols, 'Summary') === '')
check('…in any case', columnNameError('SUMMARY ', cols, 'summary') === '')
check('editing one column, renaming to ANOTHER taken name is flagged',
  columnNameError('val', cols, 'Summary') === NAME_TAKEN)
check('a symbol-only name needs a letter or digit', columnNameError('###', cols, null).includes('letter'))

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nok   ai column name')
