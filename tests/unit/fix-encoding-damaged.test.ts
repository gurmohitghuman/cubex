// Cells written while U+0080-U+009F were dropped hold sequences that lost a
// byte: text garbled as Latin-1 lost every continuation byte 0x80-0x9F, text
// garbled as Windows-1252 lost 0x81, 0x8D, 0x8F, 0x90 and 0x9D. fix_encoding
// repairs every sequence still whole and leaves the rest as it came; cleaning
// again changes nothing; and the import counts the cell, also when a damaged
// spot is its only sign. One value can't be counted: "it’s" garbled as
// Latin-1 keeps only "itâs", which reads like "pâte" or "château".
import assert from 'node:assert/strict'
import { cp1252, finish, fixEncoding, group, latin1, looksGarbled } from './fix-encoding-kit'

const dropC1 = (s: string) => s.replace(/[\u0080-\u009F]/g, '')

// word, how it was garbled, what is left, what fix_encoding gives.
const DAMAGED: Array<[string, 'Latin-1' | 'Windows-1252', string, string]> = [
  ['FraudFighter™', 'Latin-1', 'FraudFighterâ¢', 'FraudFighterâ¢'],
  ['FraudFighter™', 'Windows-1252', 'FraudFighterâ„¢', 'FraudFighter™'],
  ['CODE Éxitos', 'Latin-1', 'CODE Ãxitos', 'CODE Ãxitos'],
  ['CODE Éxitos', 'Windows-1252', 'CODE Ã‰xitos', 'CODE Éxitos'],
  ['“quoted”', 'Latin-1', 'âquotedâ', 'âquotedâ'],
  ['“quoted”', 'Windows-1252', 'â€œquotedâ€', '“quotedâ€'],
  ['Café “Müller” – Ýmir', 'Latin-1', 'CafÃ© âMÃ¼llerâ â Ãmir', 'Café âMüllerâ â Ãmir'],
  ['Café “Müller” – Ýmir', 'Windows-1252', 'CafÃ© â€œMÃ¼llerâ€ â€“ Ãmir', 'Café “Müllerâ€ – Ãmir'],
  ['Ángel Íñigo', 'Latin-1', 'Ãngel ÃÃ±igo', 'Ãngel Ãñigo'],
  ['Ángel Íñigo', 'Windows-1252', 'Ãngel ÃÃ±igo', 'Ãngel Ãñigo'],
  ['Ðorđe', 'Latin-1', 'ÃorÄe', 'ÃorÄe'],
  ['Ðorđe', 'Windows-1252', 'ÃorÄ‘e', 'Ãorđe'],
  ['Œuvre…', 'Latin-1', 'Åuvreâ¦', 'Åuvreâ¦'],
  ['Œuvre…', 'Windows-1252', 'Å’uvreâ€¦', 'Œuvre…'],
  ['Žižek', 'Latin-1', 'Å½iÅ¾ek', 'Žižek'],
  ['Žižek', 'Windows-1252', 'Å½iÅ¾ek', 'Žižek'],
  ['naïve café', 'Latin-1', 'naÃ¯ve cafÃ©', 'naïve café'],
  ['naïve café', 'Windows-1252', 'naÃ¯ve cafÃ©', 'naïve café'],
  ['it’s', 'Latin-1', 'itâs', 'itâs'],
  ['it’s', 'Windows-1252', 'itâ€™s', 'it’s'],
  ['ÉCOLE', 'Latin-1', 'ÃCOLE', 'ÃCOLE'],
  ['ÉCOLE', 'Windows-1252', 'Ã‰COLE', 'ÉCOLE'],
  ['São Paulo', 'Latin-1', 'SÃ£o Paulo', 'São Paulo'],
  ['São Paulo', 'Windows-1252', 'SÃ£o Paulo', 'São Paulo'],
  ['Ελληνικά', 'Latin-1', 'ÎÎ»Î»Î·Î½Î¹ÎºÎ¬', 'Îλληνικά'],
  ['Ελληνικά', 'Windows-1252', 'Î•Î»Î»Î·Î½Î¹ÎºÎ¬', 'Ελληνικά'],
]
// The one value whose only sign is a shape real words have too.
const NOT_COUNTED = new Set(['itâs'])

await group('stored without C1: whole sequences repaired, the rest as it came, cleaning again the same', () => {
  for (const [word, how, left, want] of DAMAGED) {
    assert.equal(dropC1((how === 'Latin-1' ? latin1 : cp1252)(word)), left, `${word} garbled as ${how}`)
    assert.equal(fixEncoding(left), want, JSON.stringify(left))
    assert.equal(fixEncoding(want), want, `cleaning ${JSON.stringify(want)} again`)
  }
})

await group('the import counts each of them, the damaged spot alone included', () => {
  const uncounted = DAMAGED.map(d => d[2]).filter(left => !looksGarbled(left))
  assert.deepEqual(uncounted, [...NOT_COUNTED])
})

await group('the shapes a lost byte leaves: counted, left as they came', () => {
  for (const s of ['FraudFighterâ¢', 'CODE Ãxitos', 'âquotedâ', 'Åuvreâ¦', 'ÃorÄe', 'a € â¬ b', 'Ãmir', 'ÃCOLE']) {
    assert.equal(looksGarbled(s), true, `counted: ${JSON.stringify(s)}`)
    assert.equal(fixEncoding(s), s, `left as it came: ${JSON.stringify(s)}`)
  }
})

finish('fix-encoding-damaged')
