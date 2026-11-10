// The fix_encoding cleaner repairs UTF-8 text read as Windows-1252 or Latin-1,
// once or twice over, around damaged spots too, and returns anything else
// exactly as it came; cleaning a cleaned value changes nothing. The import's
// "looks garbled" check is: holds a C1 character, or fix_encoding would change
// it. What it leaves alone (real text, characters the cell policy strips) is
// in fix-encoding-guards.test.ts. Each group reports on its own.
import assert from 'node:assert/strict'
import cleanersMod from '../../server/src/lib/clean/cleaners'
import { cp1252, fixEncoding, finish, group, latin1, looksGarbled, misses } from './fix-encoding-kit'
const { cleanerFn, isCleaner, defaultCleanColumnName } =
  cleanersMod as typeof import('../../server/src/lib/clean/cleaners')

const clean = cleanerFn('fix_encoding', {})
const check = (input: string, want: string) => {
  assert.equal(fixEncoding(input), want, JSON.stringify(input))
  assert.equal(clean(input), want, `through the cleaner: ${JSON.stringify(input)}`)
  assert.equal(fixEncoding(want), want, `cleaning ${JSON.stringify(want)} again changes nothing`)
}

await group('a cleaner of its own, writing "<source> (clean)"', () => {
  assert.ok(isCleaner('fix_encoding'))
  assert.equal(defaultCleanColumnName('fix_encoding', 'Company'), 'Company (clean)')
})

await group('repaired: UTF-8 read as Latin-1 (C1 characters), as Windows-1252, twice over, in capitals', () => {
  check('FraudFighterâ\u0084¢', 'FraudFighter™')
  check('CODE Ã\u0089xitos', 'CODE Éxitos')
  check('CafÃ©', 'Café')
  check('Ã¢â‚¬â„¢', '’')
  check('itâ€™s â€œquotedâ€\u009D', 'it’s “quoted”')
  check('Ð¿Ñ€Ð¸Ð²ÐµÑ‚', 'привет')
  check('ÎµÎ»Î»Î·Î½Î¹ÎºÎ¬', 'ελληνικά')
  check('æ\u2014¥æœ¬èªž', '日本語')
  check('ðŸ˜€', '😀')
  check('  CafÃ©\t\n', '  Café\t\n')
  // In capitals, and the letters of Azerbaijani, Romanian, Vietnamese, Polish and Pinyin.
  check('CAFÃ‰', 'CAFÉ')
  check('CAFÃƒâ€°', 'CAFÉ')
  check('STRAÃŸE', 'STRAßE')
  check('MÃœLLER', 'MÜLLER')
  check('COCA-COLAÂ®', 'COCA-COLA®')
  check('CAFâ€™S', 'CAF’S')
  check('BUCUREÈ˜TI', 'BUCUREȘTI')
  check('BucureÈ™ti', 'București')
  check('AzÉ™rbaycan', 'Azərbaycan')
  check('AZÆ\u008FRBAYCAN', 'AZƏRBAYCAN')
  check('TRÆ¯á»œNG', 'TRƯỜNG')
  check('Å\u0081Ã“DÅ¹', 'ŁÓDŹ')
  check('Ð¡Ð¢ÐžÐŸ', 'СТОП')
  check('hÇŽo', 'hǎo')
  check('ConstanÈ›a', 'Constanța')
  check('SÄ…', 'Są')
  // A capital and an apostrophe at the start of a word, decoded along with the value's other sequence.
  check('Å’uvreâ€¦', 'Œuvre…')
})

await group('contact data in all four garbled forms: a capital, then an accented lowercase letter', () => {
  assert.deepEqual(misses(['Müller', 'Gómez', 'Pérez', 'Sánchez', 'Málaga', 'Résumé', 'Mélanie', 'São Paulo',
    'FraudFighter™', 'CODE Éxitos', 'it’s', 'ÉCOLE', 'Ελληνικά']), [])
})

await group('twice as Latin-1: a pass may leave C1 characters a later pass removes', () => {
  check('Ã\u0083Â©', 'é')
  check('Ã¢Â\u0084Â¢', '™')
  check('MÃ\u0083Â¼ller', 'Müller')
})

await group('twice garbled right after capitals: a lead letter (â) on the way is allowed', () => {
  assert.deepEqual(misses(['MCDONALD’S', 'ACME™', 'JOSÉ', 'STRAßE', 'COCA-COLA®', 'ÉLYSÉE', 'BUCUREȘTI']), [])
})

await group('a damaged spot stays as it came, and the sequences around it are repaired', () => {
  check('José \u2013 CafÃ©', 'José \u2013 Café')
  check('â€œquotedâ€', '“quotedâ€')
  check('MÃ¼ller ✓', 'Müller ✓')
  check('MÃ¼ller 😀 and GÃ³mez', 'Müller 😀 and Gómez')
  check('MÃ¼ller 日本', 'Müller 日本')
  check('CafÃ© Łódź', 'Café Łódź')
  check('Ã©Ã', 'éÃ')
  check('Gruß“ und CafÃ©', 'Gruß“ und Café')
  check('JOSÉ’S CAFÃ‰', 'JOSÉ’S CAFÉ')
  // Without the lost no-break space nothing tells "Ã " from real text: left as it came.
  check('Ã  la carte', 'Ã  la carte')
  // Every decoded character of a value is checked, so a C1 character left anywhere keeps the value as it came.
  check('C1test\u0080\u0089end CafÃ©', 'C1test\u0080\u0089end CafÃ©')
  // Never blanks a value, and anything that isn't text reads as empty (cleaners never throw).
  assert.equal(clean('   '), '   ')
  assert.equal(fixEncoding(undefined as unknown as string), '')
})

await group('at most 3 passes: garbled 3 times is repaired; 4 times, it is left as it came', () => {
  const thrice = cp1252(cp1252(cp1252('Café')))
  const fourTimes = cp1252(thrice)
  assert.equal(fixEncoding(thrice), 'Café')
  assert.equal(fixEncoding(fourTimes), fourTimes)
  assert.equal(fixEncoding(latin1(latin1(latin1('Café')))), 'Café')
})

await group('garbled: a C1 character, or a value fix_encoding repairs (a damaged spot or not)', () => {
  for (const s of ['C1test\u0080\u0089end', 'FraudFighterâ\u0084¢', 'CODE Ã\u0089xitos', 'CafÃ©', 'Ã¢â‚¬â„¢',
    'a\u0085b', 'MÃ¼ller', 'José \u2013 CafÃ©', 'â€œquotedâ€', 'MÃ¼ller ✓']) {
    assert.equal(looksGarbled(s), true, `garbled: ${JSON.stringify(s)}`)
  }
  // Longer than MAX_CLEAN_FIELD_CHARS: only a C1 character counts.
  assert.equal(looksGarbled(`${'x'.repeat(1000)} CafÃ©`), false)
  assert.equal(looksGarbled(`${'x'.repeat(1000)} a\u0085b`), true)
})

finish('fix-encoding')
