// What fix_encoding leaves as it came: a repair never gives a character the
// cell policy strips (direction controls), and what a clean column writes goes
// through that policy too; real text (accented names, words in capitals before
// punctuation, ß before punctuation, an accented capital on its own) is never
// changed or counted as garbled, though it holds sequences that decode; and a
// seeded run over 200,000 garbled-looking strings shows cleaning twice changes
// nothing and nothing is blanked. Each group reports on its own.
import assert from 'node:assert/strict'
import {
  FORMS, finish, fixEncoding, group, hasLeadPair, looksGarbled, stripControlChars,
} from './fix-encoding-kit'
const { cleanedCell } = await import('../../server/src/services/clean-kind')

const DIRECTION = [0x200E, 0x200F, 0x061C, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069]
const hex = (c: number) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`

await group('a repair never gives a character the cell policy strips', () => {
  const found: string[] = []
  for (const code of DIRECTION) {
    for (const [name, garble] of FORMS) {
      const out = fixEncoding(garble(`invoice${String.fromCharCode(code)}fdp.exe`))
      if (stripControlChars(out) !== out) found.push(`${hex(code)} (${name}) gave ${JSON.stringify(out)}`)
      if (fixEncoding(out) !== out) found.push(`${hex(code)} (${name}): cleaning again changes it`)
    }
  }
  assert.deepEqual(found, [])
  for (const s of ['invoiceâ€®fdp.exe', 'x_â€®fdp.exe', 'a â€Ž b', 'aâ\u0081§b']) {
    assert.equal(fixEncoding(s), s, `left as it came: ${JSON.stringify(s)}`)
    assert.equal(looksGarbled(s), true, `counted as garbled: ${JSON.stringify(s)}`)
  }
})

await group('what a clean column writes goes through the cell policy', () => {
  assert.deepEqual(cleanedCell(() => 'a\u202Eb\u0000c\u0085d', 'source'), { value: 'abc\u0085d', filled: true })
  assert.deepEqual(cleanedCell(() => '\u2067', 'source'), { value: '', filled: false, flag: '' })
  assert.deepEqual(cleanedCell(() => 'never asked', ''), { value: '', filled: false })
})

const GERMAN = ['Viel Spaß…', 'Straß„', 'Fuß·', 'groß»']
const PUNCTUATION = ['…', '„', '·', '»', '“', '”', '’', '–']
const SHAPES = ['Ä', 'Ö', 'Ü', 'Ñ', 'Ç'].flatMap(l => PUNCTUATION.flatMap(p =>
  [`HAL${l}${p}`, `Das ist GR${l}${p} gut`, `${l}${p}`, `so ${l}${p} ja`]))
const CAPITALS = ['OCKSÅ…', 'AMANHÃ…', 'MITÄ”', 'PÅ’', 'JOSÉ’S TACOS', 'BEYONCÉ’S', 'NESCAFÉ™',
  'NESCAFÉ®', 'CLICHÉ”', 'CAFÉ…', 'CAFÉ–BAR', 'KOÇ’UN', 'CAFÉ\u00A0!', 'CHLOË’S', 'LUÍ’S', 'CAFÈ’S', 'RÉSUMÉ™',
  'ÉLYSÉE’S', 'PÂTÉ’S']
// Albanian puts Ç before an apostrophe; and words whose Ã, â, Å, Ä are real (not a lost byte's leftovers).
const APOSTROPHE_AND_LEADS = ['Ç’kemi', 'Ç’është', 'château', 'pâte', 'âge', 'Åsa', 'Ålesund', 'Åke', 'Ärger',
  'Äpfel', 'Ñandú', 'Ðorđe', 'SÃO PAULO', 'NÃO', 'MÃE', 'IRMÃ E IRMÃO', 'PÃO', 'ÇA VA', 'Øre', 'Ýmir']
// A lowercase accented letter before two punctuation marks makes three bytes that decode (to CJK, Hangul,
// Mandaic or a number form) in French, Spanish, Portuguese, Catalan and Turkish quotes.
const BEFORE_PUNCTUATION = ['«\u00A0Café\u00A0»', '“Cliché…”', '«Ya está…»', '«\u00A0voilà\u00A0»', 'hâlâ…”',
  'Café\u00A0– Bar', 'Café\u00A0\u00A0Paris', '«Ela é…»', '«Què…»', 'Perquè…”', '«yâ…»', 'Você está…”', 'aç…»',
  '«\u00A0Déjà\u00A0»', 'Ella está aquí…»', 'Bu güç…”']
// Welsh "â’r", Turkish words that start or end with "â", Guarani "MITÃKUÑA", capitals before a no-break space.
const LOOK_LIKE_LOST_BYTES = ['mynd â’r plant', 'gyda â’i fam', 'â’u', 'Bu âdet hâlâ sürüyor', 'hâlâ…',
  'MITÃKUÑA', 'AMANHÃ\u00A0!', 'OCKSÅ\u00A0!']
const REAL = [
  'José', 'Müller', 'Ångström', 'Øre', 'Łódź', 'São Paulo', 'Ελληνικά', '„Grüße“', 'Gruß“', 'Crème brûlée',
  'naïve café', 'Œuvre', '€100', '“quoted”', 'привет', '日本語', '😀', '👍🏽', '👨‍👩‍👧', '🇩🇪',
  'plain ASCII', '', '   ', 'x'.repeat(5000), 'Ã', 'Ñ', 'Straße', 'déjà vu', 'Ça va', 'İstanbul', 'Café’s',
  ...GERMAN, ...SHAPES, ...CAPITALS, ...APOSTROPHE_AND_LEADS, ...BEFORE_PUNCTUATION, ...LOOK_LIKE_LOST_BYTES,
]

await group('real text: never changed, never counted as garbled', () => {
  assert.deepEqual(REAL.filter(s => fixEncoding(s) !== s).map(s => `${s} gave ${fixEncoding(s)}`), [], 'changed')
  assert.deepEqual(REAL.filter(s => looksGarbled(s)), [], 'counted as garbled')
})

await group('real text that holds a sequence to decode: the checks keep it, not the first look', () => {
  for (const s of [...GERMAN, ...CAPITALS.slice(0, 6), 'HALÖ…', 'so Ä… ja', 'Gruß“', 'PÂTÉ’S', 'Ç’kemi',
    ...BEFORE_PUNCTUATION, 'mynd â’r plant', 'AMANHÃ\u00A0!']) {
    assert.equal(hasLeadPair(s), true, `a lead and a continuation in ${JSON.stringify(s)}`)
  }
})

await group('left as it came: lone C1, a chain that keeps C1, mixed scripts, a byte order mark', () => {
  for (const s of [
    'C1test\u0080\u0089end', 'a\u0085b', '  spaced  \u0084 ', 'Â\u0085', 'Ã\u0082Â\u0085', 'Gruß“', 'aß“b',
    'ï»¿Hello',
  ]) assert.equal(fixEncoding(s), s, `left alone: ${JSON.stringify(s)}`)
})

await group('200,000 seeded garbled-looking strings: cleaning twice changes nothing, nothing is blanked', () => {
  let seed = 0x5eed
  const rand = () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => String.fromCharCode(from + i))
  const cp1252High = [...new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i))]
  const ALPHABET = [
    ...range(0xA0, 0xFF), ...cp1252High, ...range(0x80, 0x9F), ...'abcXYZ 019.,-\'', '😀', '👍🏽', '日', '本',
    'Ã©', 'â€™', 'Ã¢â‚¬â„¢', 'Ð¿', 'Ã\u0083Â©', 'â\u0084¢',
  ]
  const started = Date.now()
  const bad: string[] = []
  let repaired = 0
  for (let n = 0; n < 200_000 && bad.length < 5; n++) {
    let x = ''
    for (let k = 1 + Math.floor(rand() * 10); k > 0; k--) x += ALPHABET[Math.floor(rand() * ALPHABET.length)]
    const y = fixEncoding(x)
    if (y !== x) repaired++
    if (fixEncoding(y) !== y) bad.push(`${JSON.stringify(x)}: cleaning ${JSON.stringify(y)} again changes it`)
    if (y === '') bad.push(`${JSON.stringify(x)} was blanked`)
    if (stripControlChars(y) !== y) bad.push(`${JSON.stringify(x)} gave a character the policy strips`)
  }
  const ms = Date.now() - started
  console.log(`      200,000 strings in ${ms} ms, ${repaired} of them repaired`)
  assert.deepEqual(bad, [])
  assert.ok(repaired > 20_000, `only ${repaired} repaired: the run must reach the decoder`)
  assert.ok(ms < 20_000, `took ${ms} ms`)
})

finish('fix-encoding-guards')
