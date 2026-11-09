// The fix_encoding cleaner repairs UTF-8 text read as Windows-1252 or Latin-1,
// once or twice over, and returns anything else exactly as it came; cleaning a
// cleaned value changes nothing. The import's "looks garbled" check is: holds
// a C1 character, or fix_encoding would change it. Real accented text is never
// garbled and never changed. Each group reports on its own.
import assert from 'node:assert/strict'
import fixMod from '../../server/src/lib/clean/fix-encoding'
import cleanersMod from '../../server/src/lib/clean/cleaners'
const { fixEncoding, looksGarbled } = fixMod as typeof import('../../server/src/lib/clean/fix-encoding')
const { cleanerFn, isCleaner, defaultCleanColumnName } =
  cleanersMod as typeof import('../../server/src/lib/clean/cleaners')

if (!process.env.DB_PATH) { console.error('Refusing to run without a throwaway DB_PATH set.'); process.exit(1) }

let failures = 0
function group(label: string, fn: () => void) {
  try { fn(); console.log('ok  ', label) }
  catch (e) { failures++; console.log('FAIL', label, '\n ', (e as Error).message) }
}
const clean = cleanerFn('fix_encoding', {})
const check = (input: string, want: string) => {
  assert.equal(fixEncoding(input), want, JSON.stringify(input))
  assert.equal(clean(input), want, `through the cleaner: ${JSON.stringify(input)}`)
  assert.equal(fixEncoding(want), want, `cleaning ${JSON.stringify(want)} again changes nothing`)
}
// The four ways a value gets garbled: its UTF-8 read as Latin-1 or Windows-1252, once or twice.
const utf8 = new TextEncoder()
const latin1 = (s: string) => Array.from(utf8.encode(s), b => String.fromCharCode(b)).join('')
const cp1252 = (s: string) => new TextDecoder('windows-1252').decode(utf8.encode(s))
const FORMS: Array<[string, (s: string) => string]> = [
  ['Latin-1', latin1], ['Windows-1252', cp1252],
  ['twice Latin-1', s => latin1(latin1(s))], ['twice Windows-1252', s => cp1252(cp1252(s))],
]
// Every form of every word that doesn't come back, or whose answer changes when cleaned again.
const misses = (words: string[]): string[] => words.flatMap(w => FORMS.flatMap(([name, garble]) => {
  const out = fixEncoding(garble(w))
  return [...(out === w ? [] : [`${w} (${name}) gave ${JSON.stringify(out)}`]),
    ...(fixEncoding(out) === out ? [] : [`${w} (${name}): cleaning ${JSON.stringify(out)} again changes it`])]
}))

group('a cleaner of its own, writing "<source> (clean)"', () => {
  assert.ok(isCleaner('fix_encoding'))
  assert.equal(defaultCleanColumnName('fix_encoding', 'Company'), 'Company (clean)')
})

group('repaired: UTF-8 read as Latin-1 (C1 characters), as Windows-1252, twice over, in capitals', () => {
  check('FraudFighterâ\u0084¢', 'FraudFighter™')
  check('CODE Ã\u0089xitos', 'CODE Éxitos')
  check('CafÃ©', 'Café')
  check('Ã¢â‚¬â„¢', '’')
  check('itâ€™s â€œquotedâ€\u009D', 'it’s “quoted”')
  check('Ð¿Ñ€Ð¸Ð²ÐµÑ‚', 'привет')
  check('ÎµÎ»Î»Î·Î½Î¹ÎºÎ¬', 'ελληνικά')
  check('æ—¥æœ¬èªž', '日本語')
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
})

group('contact data in all four garbled forms: a capital, then an accented lowercase letter', () => {
  assert.deepEqual(misses(['Müller', 'Gómez', 'Pérez', 'Sánchez', 'Málaga', 'Résumé', 'Mélanie', 'São Paulo',
    'FraudFighter™', 'CODE Éxitos', 'it’s', 'ÉCOLE', 'Ελληνικά']), [])
})

group('twice as Latin-1: a pass may leave C1 characters a later pass removes', () => {
  check('Ã\u0083Â©', 'é')
  check('Ã¢Â\u0084Â¢', '™')
  check('MÃ\u0083Â¼ller', 'Müller')
})

group('twice garbled right after capitals: a lead letter (â) on the way is allowed', () => {
  assert.deepEqual(misses(['MCDONALD’S', 'ACME™', 'JOSÉ', 'STRAßE', 'COCA-COLA®', 'ÉLYSÉE', 'BUCUREȘTI']), [])
})

group('real text: never changed, never garbled', () => {
  const REAL = [
    'José', 'Müller', 'Ångström', 'Øre', 'Łódź', 'São Paulo', 'Ελληνικά', '„Grüße“', 'Gruß“', 'Crème brûlée',
    'naïve café', 'Œuvre', '€100', '“quoted”', 'привет', '日本語', '😀', '👍🏽', '👨‍👩‍👧', '🇩🇪',
    'plain ASCII', '', '   ', 'x'.repeat(5000), 'Ã', 'Ñ', 'Straße', 'déjà vu', 'Ça va', 'İstanbul',
    // Capitals before punctuation: two bytes of valid UTF-8 that must not decode to "JOSɒS" or "NESCAFə".
    'JOSÉ’S TACOS', 'BEYONCÉ’S', 'NESCAFÉ™', 'NESCAFÉ®', 'CLICHÉ”', 'CAFÉ…', 'CAFÉ–BAR', 'KOÇ’UN',
    'CAFÉ !', 'CHLOË’S', 'LUÍ’S', 'CAFÈ’S', 'RÉSUMÉ™', 'Café’s', 'ÉLYSÉE’S',
  ]
  assert.deepEqual(REAL.filter(s => fixEncoding(s) !== s), [], 'changed')
  assert.deepEqual(REAL.filter(s => looksGarbled(s)), [], 'counted as garbled')
})

group('left alone, exactly as it came (spaces and C1 included)', () => {
  // Lone C1 characters; a byte sequence that isn't UTF-8; a chain of repairs
  // that never gets rid of its C1 characters; a repair that mixes Latin with
  // another script in one word ("Gruß“" would become "Gru" + an NKo letter); a
  // leading byte order mark the decoder would swallow; a character no byte reads as.
  for (const s of [
    'C1test\u0080\u0089end', 'a\u0085b', '  spaced  \u0084 ', 'Ã©Ã', 'Â\u0085', 'Ã\u0082Â\u0085', 'Gruß“',
    'aß“b', 'ï»¿Hello', 'CafÃ© Łódź', 'CafÃ©😀',
  ]) assert.equal(fixEncoding(s), s, `left alone: ${JSON.stringify(s)}`)
  // Never blanks a value, and anything that isn't text reads as empty (cleaners never throw).
  assert.equal(clean('   '), '   ')
  assert.equal(fixEncoding(undefined as unknown as string), '')
})

group('at most 3 passes: garbled 3 times is repaired; 4 times, it is left as it came', () => {
  const thrice = cp1252(cp1252(cp1252('Café')))
  const fourTimes = cp1252(thrice)
  assert.equal(fixEncoding(thrice), 'Café')
  assert.equal(fixEncoding(fourTimes), fourTimes)
  assert.equal(fixEncoding(latin1(latin1(latin1('Café')))), 'Café')
})

group('garbled: a C1 character, or a value fix_encoding repairs', () => {
  for (const s of ['C1test\u0080\u0089end', 'FraudFighterâ\u0084¢', 'CODE Ã\u0089xitos', 'CafÃ©', 'Ã¢â‚¬â„¢',
    'a\u0085b', 'MÃ¼ller']) assert.equal(looksGarbled(s), true, `garbled: ${JSON.stringify(s)}`)
})

if (failures > 0) { console.error(`${failures} fix-encoding group(s) failed`); process.exit(1) }
console.log('fix-encoding: all assertions passed')
