// Unit test for the name and company cleaners (lib/clean/person-name.ts,
// name-text.ts, company.ts and company-brackets.ts, through cleanerFn): one
// letter with a period is an initial in any script, so first_name never takes
// it as the first name; full-width letters, digits and punctuation read as
// plain ASCII and the ideographic space as a space; a closing bracket that
// closes nothing goes from either end of a company name. Every case also
// cleans its own output again with the same options, which must change nothing.
// server/src is type:commonjs → default-import + destructure under tsx.
import cleanersMod from '../../server/src/lib/clean/cleaners'
const { cleanerFn } = cleanersMod as typeof import('../../server/src/lib/clean/cleaners')
type CleanerId = import('../../server/src/lib/clean/cleaners').CleanerId
type CleanOptions = import('../../server/src/lib/clean/cleaners').CleanOptions

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
type Case = [CleanerId, string, string]
function run(options: CleanOptions, cases: Case[]) {
  for (const [cleaner, input, want] of cases) {
    const f = cleanerFn(cleaner, options)
    const got = f(input)
    const opts = Object.keys(options).length ? ` ${JSON.stringify(options)}` : ''
    const note = got === want ? '' : ` (got ${JSON.stringify(got)})`
    check(`${cleaner}${opts} ${JSON.stringify(input)} → ${JSON.stringify(want)}${note}`, got === want)
    check(`${cleaner}${opts} idempotent on ${JSON.stringify(got)}`, f(got) === got)
  }
}

// One letter and its period is an initial in a script without case too, with
// its vowel sign (कु.); the last name is never the first name, so these are blank.
run({}, [
  ['first_name', 'א. כהן', ''],
  ['first_name', 'ع. محمد', ''],
  ['first_name', 'ส. ทองคำ', ''],
  ['first_name', 'क. कुमार', ''],
  ['first_name', 'कु. कुमार', ''],
  ['first_name', '伟.', ''],
  ['first_name', 'É. Martin Dupont', 'Martin'],
  ['first_name', 'E\u{301}. Martin Dupont', 'Martin'],
  // With a word between, that word is the first name.
  ['first_name', 'א. דוד כהן', 'דוד'],
  ['first_name', 'कु. राम कुमार', 'राम'],
  // One character with no period stays a name.
  ['first_name', '伟', '伟'],
  ['first_name', '민', '민'],
  ['first_name', '王 伟', '王'],
  // The full name keeps the initial; the last name is the last word.
  ['person_name', 'कु. कुमार', 'कु. कुमार'],
  ['last_name', 'कु. कुमार', 'कुमार'],
])
run({ nameInput: 'first_name' }, [
  ['first_name', 'א. כהן', 'כהן'],
  ['first_name', 'ع. محمد', 'محمد'],
  ['first_name', 'ส. ทองคำ', 'ทองคำ'],
  ['first_name', 'क. कुमार', 'कुमार'],
  ['first_name', 'कु. कुमार', 'कुमार'],
  ['first_name', '伟', '伟'],
])

// Full-width letters, digits and punctuation, and the ideographic space.
run({}, [
  ['person_name', 'Ｏ＇Ｂｒｉｅｎ，\u{3000}Ｓｅａｎ', "Sean O'Brien"],
  ['company_name', '７－Ｅｌｅｖｅｎ', '7-Eleven'],
  ['company_name', 'Ａｃｍｅ（ＵＫ）\u{3000}Ｌｔｄ', 'Acme'],
  ['person_name', 'Ｍｉｃｈａｅｌ\u{3000}Ｓｍｉｔｈ', 'Michael Smith'],
  ['first_name', 'Ｊｏｈｎ\u{3000}Ｄｏｅ', 'John'],
  ['last_name', 'John\u{3000}Smith', 'Smith'],
])

// A closing bracket that closes nothing goes from either end of a company name.
run({}, [
  ['company_name', 'Acme }{ Beta', 'Acme'],
  ['company_name', 'Acme ) Ltd', 'Acme'],
  ['company_name', 'Acme Ltd )', 'Acme'],
  ['company_name', 'Acme ), Inc', 'Acme'],
  ['company_name', ') Acme', 'Acme'],
  ['company_name', '] [Acme', 'Acme'],
  ['company_name', 'Acme (UK) )', 'Acme'],
  ['company_name', '(Acme Ltd)', 'Acme'],
  // A stray one the leading The leaves at the start goes with it.
  ['company_name', 'THE ) Ltd& Co.', 'Ltd&'],
  // Matched pairs, and a stray one inside the name, stay.
  ['company_name', 'Acme ) Beta', 'Acme ) Beta'],
  ['company_name', 'Acme (UK) Holdings', 'Acme (UK) Holdings'],
  ['company_name', 'Acme [Beta]', 'Acme [Beta]'],
])
run({ theCompany: 'keep' }, [
  ['company_name', ') The Christman Company', 'The Christman Company'],
  ['company_name', 'The Christman Company )', 'The Christman Company'],
])

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1) }
console.log('\nall clean-initials-brackets checks passed')
