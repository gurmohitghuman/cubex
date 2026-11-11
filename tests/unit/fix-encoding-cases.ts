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
const CP: Form[] = ['Windows-1252', 'twice Windows-1252']

export interface Row { input: string; want: string; counted: boolean; why: string }

// Real text: fix_encoding leaves it as it is, and the import doesn't count it.
const stay = (why: string, ...values: string[]): Row[] => values.map(v => ({ input: v, want: v, counted: false, why }))
// Garbled forms of words: repaired whole, and counted.
const repair = (why: string, forms: Form[], ...words: string[]): Row[] =>
  words.flatMap(w => forms.map(f => ({ input: GARBLE[f](w), want: w, counted: true, why: `${why}: ${w}, ${f}` })))
// One value with what it must give.
const row = (why: string, input: string, want: string, counted: boolean): Row => ({ input, want, counted, why })
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
  ...stay('review 1, real values', '¿Qué?', '25°C', '3×4', '€100', '£5 ¥500', 'josé@café.fr', 'https://café.fr/menú'),
  row('review 1, a damaged spot', 'â€œquotedâ€', '“quotedâ€', true),
  row('review 1, a damaged spot', 'José – CafÃ©', 'José – Café', true),
  row('review 1, next to ✓', 'MÃ¼ller ✓', 'Müller ✓', true),
  row('review 1, next to an emoji', 'MÃ¼ller 😀', 'Müller 😀', true),
  row('review 1, next to 日本', 'MÃ¼ller 日本', 'Müller 日本', true),
  row('review 1, a lost no-break space', 'Ã  la carte', 'Ã  la carte', false),

  // Review 2 (8a87395).
  ...stay('review 2, an accented letter before two marks', `«${NB}Café${NB}»`, '“Cliché…”', '«Ya está…»',
    `«${NB}voilà${NB}»`, 'hâlâ…”', `Café${NB}– Bar`, `Café${NB}${NB}Paris`),
  ...stay('review 2, Welsh, Turkish and Guarani', 'mynd â’r plant', 'gyda â’i fam', 'â’u', 'Bu âdet hâlâ sürüyor',
    'hâlâ…', 'MITÃKUÑA'),
  ...stay('review 2, German prose', 'Straße „Groß“ und Maß…', 'Maß…'),
  ...stay('review 2, capitals before a no-break space', `AMANHÃ${NB}!`, `OCKSÅ${NB}!`),
  ...stay('review 2, real text not counted', 'hâlâ', 'Kâzım', 'L’âge', 'NÃO É', 'CORAÇÃO', 'TÂN BÌNH', 'Lâm Đồng',
    'KYLLÄ…', 'JOSÉ’S', 'PÂTÉ’S', 'Ç’kemi'),
  row('review 2, still repaired', 'FraudFighterâ\u0084¢', 'FraudFighter™', true),
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
  ...repair('should-fix 3, symbols after a Latin word', CP, 'Great★★★', 'Paris→Berlin', 'A→B', 'x≥5', 'Done✓'),
  ...stay('should-fix 3, no blanket exemption', `«é${NB}${NB}Paris»`),
  // Nit 5: Ã before K or R at a word start, and the signs ¡ £ ¥ after â.
  ...['ÃREA', 'ÃRBOL', 'ÃRABE', 'ÃKOS', 'ÃRIC'].map(v => row('nit 5, Á or É lost its byte', v, v, true)),
  ...stay('nit 5, real Ã before K or R', 'MITÃKUÑA', 'AKÃRAGUE', 'PIRÃRE', `hâlâ${NB}`),
  ...[['I ♥ Paris', 'I â¥ Paris'], ['x ≥ 5', 'x â¥ 5'], ['a ‡ b', 'a â¡ b'], ['♣ club', 'â£ club']]
    .map(([word, left]) => row(`nit 5, what a lost byte leaves of ${word}`, left, left, true)),
  // Nit 6: a no-break space follows a word; ¹ ² ³ aren't part of one.
  ...stay('nit 6, a capital alone before a no-break space', `«${NB}É${NB}»`, `«${NB}Â${NB}»`),
  ...stay('nit 6, a superscript after a capital and a quote', '“AMANHÃ”¹'),
  ...stay('review 3, Catalan', '«Què…»'),

  // The probes and the browser check.
  ...stay('probe, real text', 'château', 'Åsa', 'Ärger', 'SÃO PAULO', 'IRMÃ E IRMÃO', 'PÃO', 'ÇA VA', 'Øre', 'Ýmir',
    'Viel Spaß…', 'groß»', '«Ela é…»', 'José', 'Łódź', 'Ελληνικά'),
  row('probe, Latin-1 C1 in a quote', 'â€œquotedâ€\u009d', '“quoted”', true),
  row('probe, garbled', 'JosÃ© GarcÃ­a', 'José García', true),
  row('probe, garbled', 'MÃ¼ller', 'Müller', true),
  row('probe, garbled', 'CODE Ã\u0089xitos', 'CODE Éxitos', true),
  row('probe, garbled', 'itâ€™s', 'it’s', true),
  row('probe, garbled', 'FraudFighterâ„¢', 'FraudFighter™', true),
  row('probe, a symbol of its own', 'Done âœ“', 'Done ✓', true),
  row('browser check, C1 alone', 'C1test\u0080\u0089end', 'C1test\u0080\u0089end', true),
  ...['FraudFighterâ¢', 'CODE Ãxitos', 'âquotedâ', 'Åuvreâ¦', 'ÃorÄe', 'ÃCOLE']
    .map(v => row('browser check, a lost byte', v, v, true)),

  // The PR body: shapes, real text and examples.
  ...repair('PR body, four forms', FOUR, 'Müller', 'Gómez', 'Pérez', 'Sánchez', 'Málaga', 'Résumé', 'Mélanie',
    'São Paulo', 'FraudFighter™', 'CODE Éxitos', 'it’s', 'ÉCOLE', 'Ελληνικά'),
  ...stay('PR body, real text', 'Müller', 'Ångström', 'São Paulo', '„Grüße“', 'Gruß“', 'Crème brûlée', 'naïve café',
    'pâte', 'âge', 'Ålesund', 'Äpfel', 'Ñandú', 'Ðorđe', 'Œuvre', '“quoted”', 'привет', '日本語', '😀', 'NÃO', 'MÃE',
    'Ç’është', 'JOSÉ’S TACOS', 'NESCAFÉ™'),
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
  row('known edge, a quote pair around one letter', 'âaâ', 'âaâ', false),
  row('known edge, one Vietnamese letter alone', 'Má»¹', 'Má»¹', false),
  row('known edge, one Vietnamese letter alone', 'Má»¹ Tho', 'Má»¹ Tho', false),
  row('known edge, one Vietnamese letter alone', 'Hoa Ká»³', 'Hoa Ká»³', false),
  row('known edge, one Vietnamese letter alone', 'chá»\u2014', 'chá»\u2014', false),
  row('known edge, one Vietnamese letter alone', 'dá»…', 'dá»…', false),
  form('known edge, THƠ', 'THƠ', 'Windows-1252', `THÆ${NB}`, false),
  form('known edge, THƠ', 'THƠ', 'twice Windows-1252', `THÆ${NB}`, true),
  row('known edge, a Greek unit after Latin', '10kÎ©', '10kÎ©', false),
  row('known edge, a Greek unit after Latin', '100Î¼F', '100Î¼F', false),
]
