// One table of every value named while the fix_encoding change was reviewed, so a change that breaks
// an earlier case fails here, not later. Each row: the input (a value, or a word garbled one way), what
// fix_encoding must give, whether the import counts it as garbled, and where the case comes from. Real text stays
// as it is and isn't counted; garbled text is repaired whole and counted; known edges give exactly what their row
// says (docs/mcp.md lists them).
import { cp1252, latin1 } from './fix-encoding-kit'

export type Form = 'Latin-1' | 'Windows-1252' | 'twice Latin-1' | 'twice Windows-1252'
  | 'Latin-1, C1 lost' | 'Windows-1252, C1 lost'
const dropC1 = (s: string) => s.replace(/[\u0080-\u009F]/g, '')
export const GARBLE: Record<Form, (s: string) => string> = {
  'Latin-1': latin1,
  'Windows-1252': cp1252,
  'twice Latin-1': s => latin1(latin1(s)),
  'twice Windows-1252': s => cp1252(cp1252(s)),
  'Latin-1, C1 lost': s => dropC1(latin1(s)),
  'Windows-1252, C1 lost': s => dropC1(cp1252(s)),
}
const FOUR: Form[] = ['Latin-1', 'Windows-1252', 'twice Latin-1', 'twice Windows-1252']
const ONCE: Form[] = ['Latin-1', 'Windows-1252']

export interface Row { input: string; want: string; counted: boolean; why: string }

// Real text: fix_encoding leaves it as it is, and the import doesn't count it.
const stay = (why: string, ...values: string[]): Row[] => values.map(v => ({ input: v, want: v, counted: false, why }))
// Garbled forms of words: repaired whole, and counted. A form that gives the same input as an earlier one (a
// word Latin-1 and Windows-1252 garble alike) is left out.
const repair = (why: string, forms: Form[], ...words: string[]): Row[] => words.flatMap(w => forms
  .filter((f, i) => forms.findIndex(o => GARBLE[o](w) === GARBLE[f](w)) === i)
  .map(f => ({ input: GARBLE[f](w), want: w, counted: true, why: `${why}: ${w}, ${f}` })))
// One value with what it must give.
const row = (why: string, input: string, want: string, counted: boolean): Row => ({ input, want, counted, why })
// Forms of a word that stay garbled: each gives the word garbled `left` times (0: as it came) and is counted or not.
const left = (why: string, word: string, forms: [Form, number, boolean][]): Row[] =>
  forms.map(([f, times, counted]) => {
    const want = times === 0 ? GARBLE[f](word) : f.includes('Latin-1') ? GARBLE['Latin-1'](word) : cp1252(word)
    return { input: GARBLE[f](word), want, counted, why: `${why}: ${word}, ${f}` }
  })
// A garbled form with what it must give.
const form = (why: string, word: string, f: Form, want: string, counted: boolean): Row =>
  ({ input: GARBLE[f](word), want, counted, why: `${why}: ${word}, ${f}` })

const NB = '\u00A0'
export const ROWS: Row[] = [
  // Review 1 (2bab1e6).
  row('review 1, a direction control', 'x_â€®fdp.exe', 'x_â€®fdp.exe', true),
  row('review 1, a direction control', 'a â€Ž b', 'a â€Ž b', true),
  row('review 1, a direction control', 'aâ\u0081§b', 'aâ\u0081§b', true),
  ...stay('review 1, ß before punctuation', 'Viel Spaß…', 'Straß„', 'Fuß·', 'groß»'),
  ...stay('review 1, capitals before punctuation', 'OCKSÅ…', 'AMANHÃ…', 'MITÄ”', 'PÅ’'),
  row('review 1, a damaged spot', 'â€œquotedâ€', '“quotedâ€', true),
  row('review 1, a damaged spot', 'José – CafÃ©', 'José – Café', true),
  row('review 1, next to ✓', 'MÃ¼ller ✓', 'Müller ✓', true),
  row('review 1, next to an emoji', 'MÃ¼ller 😀', 'Müller 😀', true),
  row('review 1, next to 日本', 'MÃ¼ller 日本', 'Müller 日本', true),

  // Review 2 (8a87395).
  ...stay('review 2, an accented letter before two marks', `«${NB}Café${NB}»`, '“Cliché…”', '«Ya está…»',
    `«${NB}voilà${NB}»`, 'hâlâ…”', `Café${NB}– Bar`, `Café${NB}${NB}Paris`),
  ...stay('review 2, German prose', 'Straße „Groß“ und Maß…', 'Maß…'),
  ...stay('review 2, capitals before a no-break space', `AMANHÃ${NB}!`, `OCKSÅ${NB}!`),
  ...stay('review 2, real text not counted', 'KYLLÄ…', 'JOSÉ’S', 'PÂTÉ’S', 'Ç’kemi'),
  row('review 2, still repaired', 'BucureÈ™ti', 'București', true),
  row('review 2, the em dash', 'â€”', '\u2014', true),
  row('review 2, the euro', 'â‚¬5', '€5', true),
  row('review 2, a dash', 'â€“', '–', true),
  row('review 2, quotes', 'â€˜xâ€™', '‘x’', true),

  // Review 3 (1214b20): should-fix 1, capitals decoded in the same pass.
  ...repair('should-fix 1, Greek and Cyrillic capitals', FOUR, 'ΑΘΗΝΑ', 'ΕΛΕΝΗ', 'ΜΑΡΙΑ', 'ИВАНОВ', 'ПЕТРОВ', 'ГОРОД',
    'МОРЕ', 'ДОКТОР'),
  ...repair('should-fix 1, à and Ê at a word end', FOUR, 'Bienvenue à Paris', 'déjà là', 'voilà', 'città', 'già',
    'jusqu’à', 'VOCÊ', '«Ça va»'),
  ...repair('should-fix 1, a capital decoded before the last one', FOUR, 'PŘÍLIŠ'),
  // Should-fix 2: an accented letter before » and one more mark.
  ...stay('should-fix 2, á before » and a mark', `«Ya está»\u2014dijo él`, 'está»¹', `Ya está»${NB}y`,
    '“Ele disse «está»”'),
  ...repair('should-fix 2, Vietnamese sentences', FOUR, 'Hà Nội và Mỹ Tho', 'Tiếng Việt', 'Thành phố Hồ Chí Minh'),
  // á» and a mark no closing quote takes (“ ‘ • ‹ ›), or … inside a word, is a Vietnamese letter, even alone in a cell.
  ...repair('should-fix 2, one Vietnamese word alone', FOUR, 'Nguyễn', 'Hồ', 'Số', 'Tổ', 'thị', 'mới', 'từ', 'TỔNG'),
  // Should-fix 3: Japanese, Chinese, Korean and symbols right after a Latin word.
  ...repair('should-fix 3, CJK after a Latin word', FOUR, 'USBケーブル', 'Tシャツ', 'iPhone用ケース', 'Amazonギフト券',
    'Samsung갤럭시', 'LG전자', 'Wi-Fi接続', '日本語のiPhoneケース'),
  ...repair('should-fix 3, symbols after a Latin word', FOUR, 'Great★★★', 'Paris→Berlin', 'A→B', 'x≥5', 'Done✓'),
  ...stay('should-fix 3, no blanket exemption', `«é${NB}${NB}Paris»`),
  // Nit 5: Ã before K or R at a word start, and the signs ¡ £ ¥ after â.
  ...['ÃREA', 'ÃRBOL', 'ÃRABE', 'ÃKOS', 'ÃRIC'].map(v => row('nit 5, Á or É lost its byte', v, v, true)),
  ...[['I ♥ Paris', 'I â¥ Paris'], ['x ≥ 5', 'x â¥ 5'], ['a ‡ b', 'a â¡ b'], ['♣ club', 'â£ club']]
    .map(([word, left]) => row(`nit 5, what a lost byte leaves of ${word}`, left, left, true)),
  // Nit 6: a no-break space follows a word; ¹ ² ³ aren't part of one.
  ...stay('nit 6, a capital alone before a no-break space', `«${NB}É${NB}»`, `«${NB}Â${NB}»`),
  ...stay('nit 6, a superscript after a capital and a quote', '“AMANHÃ”¹'),
  ...stay('review 3, Catalan', '«Què…»'),

  // The probes and the browser check.
  ...stay('probe, real text', '«Ela é…»'),
  row('probe, Latin-1 C1 in a quote', 'â€œquotedâ€\u009d', '“quoted”', true),
  row('probe, garbled', 'JosÃ© GarcÃ­a', 'José García', true),
  row('probe, a symbol of its own', 'Done âœ“', 'Done ✓', true),
  row('browser check, C1 alone', 'C1test\u0080\u0089end', 'C1test\u0080\u0089end', true),
  ...['FraudFighterâ¢', 'CODE Ãxitos', 'âquotedâ', 'Åuvreâ¦', 'ÃorÄe', 'ÃCOLE']
    .map(v => row('browser check, a lost byte', v, v, true)),

  // The PR body: shapes, real text and examples.
  ...repair('PR body, four forms', FOUR, 'Müller', 'Gómez', 'Pérez', 'Sánchez', 'Málaga', 'Résumé', 'Mélanie',
    'São Paulo', 'FraudFighter™', 'CODE Éxitos', 'it’s', 'ÉCOLE', 'Ελληνικά'),
  ...stay('PR body, real text', 'Gruß“', 'Ç’është', 'JOSÉ’S TACOS', 'NESCAFÉ™'),
  row('PR body', 'ConstanÈ›a', 'Constanța', true),
  row('PR body', 'CAFÃ‰', 'CAFÉ', true),
  row('PR body', 'STRAÃŸE', 'STRAßE', true),
  row('PR body', 'SÄ…', 'Są', true),
  row('PR body', 'Å’uvreâ€¦', 'Œuvre…', true),
  row('PR body', 'Ã¢â‚¬â„¢', '’', true),
  row('PR body', `Ã${NB} la carte`, 'à la carte', true),
  row('PR body', `vou Ã${NB} praia`, 'vou à praia', true),
  // Known edges: what each gives (docs/mcp.md lists them).
  row('known edge, ambiguous two characters', 'Ð°', 'а', true),
  row('known edge, ambiguous two characters', 'Å½', 'Ž', true),
  row('known edge, Windows-1252 capitals before punctuation', 'KYLLÃ„', 'KYLLÃ„', false),
  row('known edge, Windows-1252 capitals before punctuation', 'OCKSÃ…', 'OCKSÃ…', false),
  row('known edge, one Cyrillic letter alone', 'Ð’', 'Ð’', false),
  row('known edge, Œ before an apostrophe alone', 'Å’uvre', 'Å’uvre', false),
  row('known edge, the shape of Polish Są', 'HÄ…', 'Hą', true),
  row('known edge, one Vietnamese letter alone', 'Má»¹', 'Má»¹', false),
  row('known edge, one Vietnamese letter alone', 'Má»¹ Tho', 'Má»¹ Tho', false),
  row('known edge, one Vietnamese letter alone', 'Hoa Ká»³', 'Hoa Ká»³', false),
  row('known edge, one Vietnamese letter alone', 'chá»\u2014', 'chá»\u2014', false),
  row('known edge, one Vietnamese letter alone', 'dá»…', 'dá»…', false),
  form('known edge, THƠ', 'THƠ', 'Windows-1252', `THÆ${NB}`, false),
  form('known edge, THƠ', 'THƠ', 'twice Windows-1252', `THÆ${NB}`, true),
  row('known edge, a Greek unit after Latin', '10kÎ©', '10kÎ©', false),
  row('known edge, a Greek unit after Latin', '100Î¼F', '100Î¼F', false),

  // Review 4 (aeaba37): should-fix 1, other scripts glued to a Latin word repair whole (Thai, Myanmar, Hindi,
  // Sinhala, Gujarati, Lao, Bengali, Tamil, Georgian).
  ...repair('review 4, should-fix 1, a script run after a Latin word', FOUR, 'Nikeรองเท้า', 'Nikeမြန်မာ', 'Nikeजूते',
    'Nikeසපත්තු', 'Nikeજૂતા', 'Nikeລາວ', 'Nikeজুতা', 'Nikeகாலணி', 'Nikeფეხსაცმელი'),
  // Should-fix 2: a word in capitals ending in a capital and a footnote mark stays; capitals still repair.
  ...stay('review 4, should-fix 2, a footnote mark after capitals', 'AMANHÃ²', 'CIDADÃ³', 'IRMÃ²', 'AMANHÃ² e', 'GÅ³',
    'MÄ³', 'TÈ¹', 'PÅ³', '“AMANHÃ²”'),
  ...repair('review 4, should-fix 2, a capital or one before a footnote mark', FOUR, 'LIETUVIŲ', 'Só', 'Jó'),
  row('known edge, a capital before a footnote mark', 'KYLLÄ¹', 'KYLLĹ', true),
  row('known edge, a capital before a footnote mark', 'PÅ²', 'PŲ', true),
  // Nit 3: a single Japanese, Chinese or Korean character stays (its bytes are those of "«café™»").
  ...['iPhone用', 'A股', '王', '김'].flatMap(w => left('known edge, a single CJK character', w, [
    ['Latin-1', 0, true], ['Windows-1252', 0, false], ['twice Latin-1', 0, true], ['twice Windows-1252', 1, true]])),
  // "端" garbles alike as Latin-1 and Windows-1252, with no C1 character.
  ...left('known edge, a single CJK character', 'PC端', [['Windows-1252', 0, false], ['twice Windows-1252', 1, true]]),
  ...stay('review 4, nit 3, real text of the same bytes', '«café™»', '“café”®', '«Nescafé®»'),
  // Nit 4: Vietnamese edges garbled twice come back garbled once; inside a word they repair.
  ...['Mỹ', 'Hoa Kỳ', 'dễ'].flatMap(w => left('known edge, one Vietnamese letter alone', w,
    [['twice Windows-1252', 1, true]])),
  ...repair('review 4, nit 4, ỳ inside a word', FOUR, 'Quỳnh', 'QUỲNH'),
  // Nit 6: a Guarani word starting with Ã before a lowercase letter is counted.
  row('known edge, Ã and a lowercase letter', 'Ãga', 'Ãga', true),
  // Nit 7: Greek units after a Latin letter, garbled twice, come back garbled once.
  ...['10kΩ', '100μF'].flatMap(w => left('known edge, a Greek unit after Latin', w, [
    ['twice Latin-1', 1, true], ['twice Windows-1252', 1, true]])),

  // Review 5 (8b9a7ad): should-fix 1, a × read with the character after it stays unless it touches another
  // sequence; Hebrew words come as runs of such sequences and repair.
  ...stay('review 5, should-fix 1, × between numbers', `1920${NB}×${NB}1080`, `Résolution${NB}: 1920${NB}×${NB}1080`,
    `30${NB}×${NB}40 cm`, `120${NB}×${NB}80${NB}×${NB}45 cm`, `×${NB}2`, '1920 × 1080', '120 × 80 × 45 cm', '× 2',
    `10${NB}×²`, `A${NB}×${NB}B`),
  ...repair('review 5, should-fix 1, Hebrew', FOUR, 'נתניהו', 'שלום', 'מחיר: 100₪', 'Nike שלום', 'עברית'),
  ...left('known edge, a Hebrew letter alone', 'ש', [['Windows-1252', 0, false], ['twice Windows-1252', 1, true]]),
  ...left('known edge, a Hebrew word glued to a Latin word', 'Nikeשלום', [['Latin-1', 0, true],
    ['Windows-1252', 0, true], ['twice Latin-1', 0, true], ['twice Windows-1252', 0, true]]),
  // Nit 2: the footnote shape is decoded only along with other garbled text.
  row('review 5, nit 2, Lithuanian', 'JÅ³ vaikai ir Å¡uo', 'Jų vaikai ir šuo', true),
  row('review 5, nit 2, Lithuanian', 'TÅ³ Å¾moniÅ³', 'Tų žmonių', true),
  row('known edge, Lithuanian Jų alone', 'JÅ³ namai', 'JÅ³ namai', false),
  ...stay('review 5, nit 2, footnote words', 'São Paulo AMANHÃ³', '«AMANHÃ²»', 'MÅ³'),
  // Nit 3: footnote and sign shapes that change, and are counted.
  ...[['LÃ¹', 'Lù'], ['FÃ²', 'Fò'], ['SÃ²', 'Sò'], ['RÃ³', 'Ró'], ['Classe É¹', 'Classe ɹ'], ['Tipo Ó²', 'Tipo Ӳ'],
    ['IRMÃ®', 'IRMî'], ['AMANHÃ™', 'AMANHÙ'], ['PÅ®', 'PŮ']]
    .map(([v, gives]) => row('known edge, a footnote or a sign after capitals', v, gives, true)),
  ...stay('review 5, nit 3, a capital É before a sign', 'NESCAFÉ®', 'CAFÉ¹', 'VOCÊ²'),
]

// Values with no sequence to decode: fix_encoding can't change them, and the import must not count them (the
// shapes a lost byte leaves are read in them). All are real text but two that look garbled and aren't counted:
// "Ã  la carte" lost the no-break space of "à", and "âaâ" is a quote pair around one letter.
export const NOTHING_TO_DECODE = [
  '¿Qué?', '25°C', '3×4', '€100', '£5 ¥500', 'josé@café.fr', 'https://café.fr/menú', 'Ã  la carte', 'mynd â’r plant',
  'gyda â’i fam', 'â’u', 'Bu âdet hâlâ sürüyor', 'hâlâ…', 'MITÃKUÑA', 'hâlâ', 'Kâzım', 'L’âge', 'NÃO É', 'CORAÇÃO',
  'TÂN BÌNH', 'Lâm Đồng', 'AKÃRAGUE', 'PIRÃRE', `hâlâ${NB}`, 'château', 'Åsa', 'Ärger', 'SÃO PAULO', 'IRMÃ E IRMÃO',
  'PÃO', 'ÇA VA', 'Øre', 'Ýmir', 'José', 'Łódź', 'Ελληνικά', 'Müller', 'Ångström', 'São Paulo', '„Grüße“',
  'Crème brûlée', 'naïve café', 'pâte', 'âge', 'Ålesund', 'Äpfel', 'Ñandú', 'Ðorđe', 'Œuvre', '“quoted”', 'привет',
  '日本語', '😀', 'NÃO', 'MÃE', 'âaâ',
]
