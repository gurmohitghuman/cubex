// Unit test for the name and company cleaners' fixes (lib/clean/name-text.ts,
// person-name.ts, company.ts, through cleanerFn): emoji dropped, initials
// skipped by first_name, placeholders left blank, name_input (a column of
// first names only, or last names only), full-width letters read as plain
// ones, an unclosed bracket cut, the_company, and what already worked kept.
// Every case also cleans its own output again with the same options, which
// must change nothing (auto-run cleans rows again).
// server/src is type:commonjs → default-import + destructure under tsx.
// Over 200 lines: one table of cases per decision, read top to bottom.
import cleanersMod from '../../server/src/lib/clean/cleaners'
const { cleanerFn } = cleanersMod as typeof import('../../server/src/lib/clean/cleaners')
type CleanerId = import('../../server/src/lib/clean/cleaners').CleanerId
type CleanOptions = import('../../server/src/lib/clean/cleaners').CleanOptions

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
function expectClean(cleaner: CleanerId, options: CleanOptions, input: string, want: string) {
  const f = cleanerFn(cleaner, options)
  const got = f(input)
  const opts = Object.keys(options).length ? ` ${JSON.stringify(options)}` : ''
  const note = got === want ? '' : ` (got ${JSON.stringify(got)})`
  check(`${cleaner}${opts} ${JSON.stringify(input)} → ${JSON.stringify(want)}${note}`, got === want)
  check(`${cleaner}${opts} idempotent on ${JSON.stringify(got)}`, f(got) === got)
}
type Case = [CleanerId, string, string]
const run = (options: CleanOptions, cases: Case[]) => { for (const [c, i, w] of cases) expectClean(c, options, i, w) }

// 1. Emoji, flags and the symbols among them go, with the spaces they leave.
run({}, [
  ['last_name', 'Kowalski 👋', 'Kowalski'],
  ['company_name', 'Docsumo 📄', 'Docsumo'],
  ['company_name', 'Vector 👻', 'Vector'],
  ['last_name', 'Siklitska🇺🇦', 'Siklitska'],
  ['person_name', 'Katie Siklitska 🇺🇦', 'Katie Siklitska'],
  ['first_name', 'Katie Siklitska 🇺🇦', 'Katie'],
  // A skin tone and a joiner sequence (woman technologist), a family, a subdivision flag (tag characters).
  ['first_name', 'Katie 👩🏽‍💻 Siklitska', 'Katie'],
  ['person_name', 'Jane 👨‍👩‍👧 Doe', 'Jane Doe'],
  ['person_name', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} Ewan McGregor', 'Ewan McGregor'],
  ['person_name', 'John😀Smith', 'John Smith'],
  // A keycap goes whole; a digit, # or * on its own stays.
  ['company_name', 'Acme 1️⃣', 'Acme'],
  ['company_name', '3M', '3M'],
  ['company_name', 'Studio #9', 'Studio #9'],
  ['company_name', 'Acme*', 'Acme*'],
  // © ® ™ are pictographs too, dropped before NFKC would turn ™ into TM.
  ['company_name', 'Coca-Cola®', 'Coca-Cola'],
  ['company_name', 'FraudFighter™', 'FraudFighter'],
  ['company_name', '©Acme Inc', 'Acme'],
  // Only emoji: blank.
  ['person_name', '👋', ''],
  ['company_name', '🚀🚀', ''],
  ['last_name', '🇺🇦', ''],
  // A joiner between letters of a joining script is spelling, not an emoji's.
  ['person_name', 'سا‍را', 'سا‍را'],
])

// 2. Initials: first_name gives the first word that isn't one; a lone one is blank.
run({}, [
  ['first_name', 'J. Michael', 'Michael'],
  ['first_name', 'J. Michael Fox', 'Michael'],
  ['first_name', 'J.', ''],
  ['first_name', 'J', ''],
  ['first_name', 'j. michael fox', 'Michael'],
  ['first_name', 'J. MICHAEL FOX', 'Michael'],
  // Dotted initials of two letters or more, and two-letter names, are names people go by.
  ['first_name', 'J.R. Smith', 'J.R.'],
  ['first_name', 'A.J. Styles', 'A.J.'],
  ['first_name', 'AJ Styles', 'AJ'],
  ['first_name', 'Bo Derek', 'Bo'],
  // Initials only before the last name: none (a comma says which word is the last name).
  ['first_name', 'Smith, J.', ''],
  ['first_name', 'J. R. R. Tolkien', ''],
  ['first_name', 'J. van Beethoven', ''],
  // The full name keeps its initials; the last name is as before.
  ['person_name', 'J. Michael Fox', 'J. Michael Fox'],
  ['last_name', 'J. Michael Fox', 'Fox'],
])

// 3. Placeholders: blank in every name cleaner and company_name, whole values only.
const PLACEHOLDER_INPUTS = ['n/a', 'N/A', 'n.a.', 'N.A.', 'na', 'NA', 'none', 'None', 'NULL', 'nil', '-', '--', '?',
  'unknown', 'Unknown', 'test', 'TEST', 'tbd', 'TBD', 'blank', ' (none) ', '[N/A]', 'n/a.', '{null}', 'N/A 👋']
for (const c of ['person_name', 'first_name', 'last_name', 'company_name'] as const) {
  for (const v of PLACEHOLDER_INPUTS) expectClean(c, {}, v, '')
}
run({}, [
  // "Na" written so is a name (Li Na, Na Young) on the person name cleaners, not on company_name.
  ['person_name', 'Na', 'Na'],
  ['first_name', 'Na', 'Na'],
  ['last_name', 'Na', 'Na'],
  ['company_name', 'Na', ''],
  ['person_name', 'Li Na', 'Li Na'],
  ['last_name', 'Li Na', 'Na'],
  ['last_name', 'LI NA', 'Na'],
  ['first_name', 'Na Young', 'Na'],
  // Only whole values.
  ['company_name', 'Test Kitchen', 'Test Kitchen'],
  ['company_name', 'None Such', 'None Such'],
  ['person_name', 'Nancy Unknown', 'Nancy Unknown'],
  ['person_name', 'Tess Nil', 'Tess Nil'],
  // A cleaned value that is a placeholder is blank too, so cleaning it again changes nothing.
  ['company_name', 'Unknown Corp', ''],
  ['person_name', 'Mr. Test', ''],
  ['first_name', 'Test User', ''],
  ['last_name', 'Nancy Unknown', ''],
])

// 4. name_input: a column of first names only, or last names only.
run({}, [
  // Whole names (the default): as before.
  ['first_name', 'Dr. Sarah', ''],
  ['first_name', 'Mr John', ''],
  ['last_name', 'SMITH JONES', 'Jones'],
])
run({ nameInput: 'full_name' }, [
  ['first_name', 'Dr. Sarah', ''],
  ['last_name', 'SMITH JONES', 'Jones'],
  ['first_name', 'J. Michael Fox', 'Michael'],
])
run({ nameInput: 'first_name' }, [
  ['first_name', 'Dr. Sarah', 'Sarah'],
  ['first_name', 'Mr John', 'John'],
  ['first_name', 'MARY ANN', 'Mary Ann'],
  ['first_name', 'mary-kate', 'Mary-Kate'],
  ['first_name', 'J. Michael', 'Michael'],
  ['first_name', 'J.', ''],
  ['first_name', 'J', ''],
  ['first_name', 'Robert (Bob)', 'Robert'],
  ['first_name', 'William "Bill"', 'William'],
  ['first_name', 'Sarah 👋', 'Sarah'],
  ['first_name', 'n/a', ''],
  ['first_name', 'Ｍｉｃｈａｅｌ', 'Michael'],
  ['first_name', 'DeShawn', 'DeShawn'],
])
run({ nameInput: 'last_name' }, [
  ['last_name', 'SMITH JONES', 'Smith Jones'],
  ['last_name', 'VAN DER BERG', 'van der Berg'],
  ['last_name', 'Smith Jr.', 'Smith'],
  ['last_name', 'Smith, Jr.', 'Smith'],
  ['last_name', "o'brien", "O'Brien"],
  ['last_name', 'Mr. Smith', 'Smith'],
  ['last_name', 'MACDONALD', 'MacDonald'],
  ['last_name', 'de la Vega', 'de la Vega'],
  ['last_name', 'smith-jones', 'Smith-Jones'],
  ['last_name', 'Kowalski 👋', 'Kowalski'],
  ['last_name', 'unknown', ''],
  ['last_name', 'Kim (they/them)', 'Kim'],
])

// 5. Full-width letters and other compatibility forms read as plain ones (NFKC).
run({}, [
  ['person_name', 'Ｍｉｃｈａｅｌ', 'Michael'],
  ['first_name', 'Ｍｉｃｈａｅｌ', 'Michael'],
  ['last_name', 'Ｍｉｃｈａｅｌ', 'Michael'],
  ['person_name', 'Ｊ． Ｍｉｃｈａｅｌ Ｆｏｘ', 'J. Michael Fox'],
  ['company_name', 'ＡＣＭＥ　ＩＮＣ', 'Acme'],
  ['person_name', 'ﬁona smith', 'Fiona Smith'],
  // An acute accent typed as an apostrophe stays (NFKC would make it a space and a mark).
  ['person_name', 'Sean O´Brien', 'Sean O´Brien'],
  // Accents typed as two characters come out composed.
  ['person_name', 'José García', 'José García'],
])

// 6. A bracket that never closes goes with what follows it (company_name).
run({}, [
  ['company_name', 'ImagineSoftware (Technology Partners', 'ImagineSoftware'],
  ['company_name', 'ACME (TECHNOLOGY PARTNERS', 'Acme'],
  ['company_name', 'Acme [Holdings', 'Acme'],
  ['company_name', 'Acme {beta', 'Acme'],
  ['company_name', 'Acme Inc (formerly Foo', 'Acme'],
  // Nothing named before it: what follows is the name.
  ['company_name', '(Acme Corp', 'Acme'],
  ['company_name', '[Globex LLC', 'Globex'],
  // Closed brackets as before.
  ['company_name', 'Acme (UK) Ltd', 'Acme'],
  ['company_name', 'Acme (NYSE: ACM)', 'Acme'],
  ['company_name', 'Acme (UK) Holdings', 'Acme (UK) Holdings'],
  ['company_name', 'Acme (Foo, a subsidiary of Bar)', 'Acme'],
])

// 7. the_company: strip (the default) drops "The ... Company"; keep keeps both.
run({}, [
  ['company_name', 'The Christman Company', 'Christman'],
  ['company_name', 'The Coca-Cola Company', 'Coca-Cola'],
])
run({ theCompany: 'strip' }, [['company_name', 'The Christman Company', 'Christman']])
run({ theCompany: 'keep' }, [
  ['company_name', 'The Christman Company', 'The Christman Company'],
  ['company_name', 'THE CHRISTMAN COMPANY, INC.', 'The Christman Company'],
  ['company_name', 'The Coca-Cola Company', 'The Coca-Cola Company'],
  ['company_name', 'The Acme Corporation', 'The Acme Corporation'],
  ['company_name', 'The Goldman Sachs & Co. LLC', 'The Goldman Sachs & Co'],
  // Other legal endings still go; a name without The is cleaned as with strip.
  ['company_name', 'The Home Depot, Inc.', 'The Home Depot'],
  ['company_name', 'Acme Company', 'Acme'],
  ['company_name', 'Acme, Inc.', 'Acme'],
  ['company_name', 'The Christman Company 🏗️', 'The Christman Company'],
  ['company_name', 'n/a', ''],
])

// 8. What already worked, each its own case.
run({}, [
  ['person_name', 'Smith, John', 'John Smith'],
  ['first_name', 'Smith, John', 'John'],
  ['last_name', 'Smith, John', 'Smith'],
  ['person_name', 'William "Bill" Gates', 'William Gates'],
  ['person_name', 'Robert (Bob) Jones', 'Robert Jones'],
  ['person_name', 'Alex Kim (they/them)', 'Alex Kim'],
  ['person_name', 'Jane Doe, MBA, PMP', 'Jane Doe'],
  ['person_name', 'Sam Lee PhD', 'Sam Lee'],
  ['person_name', "o'brien", "O'Brien"],
  ['last_name', "o'brien", "O'Brien"],
  ['last_name', 'MACDONALD', 'MacDonald'],
  ['person_name', 'ANGUS MACDONALD', 'Angus MacDonald'],
  ['company_name', 'Acme, Inc.', 'Acme'],
  ['company_name', 'Globex LLC', 'Globex'],
  ['company_name', 'Initech GmbH', 'Initech'],
])

// The other cleaners don't change: no emoji dropped, no NFKC, no placeholders.
run({}, [
  ['title_case', 'n/a', 'N/A'],
  ['trim', 'Kowalski 👋', 'Kowalski 👋'],
  ['lowercase', 'Ｍｉｃｈａｅｌ', 'ｍｉｃｈａｅｌ'],
])

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall clean-name-fixes checks passed')
