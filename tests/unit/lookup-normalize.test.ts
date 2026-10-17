// How lookups compare values (lib/lookup/normalize.ts, pure): run markers read
// empty; NFC, trimmed (no-break spaces too) and lowercased in Unicode; a long
// key hashed after a space; contains text cut without splitting a character;
// characters counted as code points; FTS strings quoted.
import normMod from '../../server/src/lib/lookup/normalize'
const { lookupValue, lookupKey, lookupText, containsTooShort, trigramsOf, ftsString } =
  normMod as typeof import('../../server/src/lib/lookup/normalize')

let failures = 0
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label, detail === undefined ? '' : JSON.stringify(detail)) }
}

check('run markers read empty', ['⏳ Processing...', ' ❌ failed', '⏭️ Not found', '➕ Adding 3 rows…']
  .every(v => lookupValue(v) === ''))
check('null and undefined are empty', lookupValue(null) === '' && lookupValue(undefined) === '')
check('trimmed of spaces, tabs, line breaks and no-break spaces', lookupValue('  Acme\t\n') === 'acme')
check('lowercased beyond A-Z', lookupValue('SOCIÉTÉ ÄRZTE') === 'société ärzte')
check('one letter however it was typed (NFC)', lookupValue('Café') === lookupValue('Café'))
check('numbers read as text', lookupValue(42) === '42' && lookupValue(1.5) === '1.5')
check('inner spaces kept', lookupValue('a  b') === 'a  b')
const long = 'x'.repeat(600)
check('a short key is the value', lookupKey('acme.com') === 'acme.com')
check('a long key is a hash after a space, the same each time',
  lookupKey(long).startsWith(' ') && lookupKey(long).length === 65 && lookupKey(long) === lookupKey(long))
check('two long values differ', lookupKey(long) !== lookupKey(long + 'y'))
check('text is cut to 1,000 characters', lookupText('y'.repeat(1500)).length === 1000)
const emoji = 'a'.repeat(999) + '😀'
check('the cut never splits a character', lookupText(emoji).length === 999, lookupText(emoji).length)
check('contains needs 3 characters, counted as people count them',
  containsTooShort('ab') && !containsTooShort('abc')
  && containsTooShort('😀😀') && !containsTooShort('😀😀😀'))
check('trigrams are distinct and in code points', JSON.stringify(trigramsOf('aaaa')) === '["aaa"]'
  && JSON.stringify(trigramsOf('😀ab')) === '["😀ab"]')
check('FTS strings double their quotes', ftsString('say "hi"') === '"say ""hi"""')

console.log(failures === 0 ? '\nlookup normalize: all passed' : `\nlookup normalize: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
