// Unit test for lib/clean/person-name.ts: full, first and last name. Each
// cleaner also cleans its own output again, which must change nothing
// (auto-run cleans rows again). server/src is type:commonjs → default-import
// + destructure under tsx.
import personMod from '../../server/src/lib/clean/person-name'
const { cleanPersonName, cleanFirstName, cleanLastName } =
  personMod as typeof import('../../server/src/lib/clean/person-name')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
function expectClean(name: string, f: (v: string) => string, input: string, want: string) {
  const got = f(input)
  const note = got === want ? '' : ` (got ${JSON.stringify(got)})`
  check(`${name} ${JSON.stringify(input)} → ${JSON.stringify(want)}${note}`, got === want)
  check(`${name} idempotent on ${JSON.stringify(got)}`, f(got) === got)
}

// [input, full, first, last]
const cases: [string, string, string, string][] = [
  ['JOHN SMITH', 'John Smith', 'John', 'Smith'],
  ['smith, john q.', 'John Q. Smith', 'John', 'Smith'],
  ['Smith Jr., John', 'John Smith', 'John', 'Smith'],
  ['John Smith, PhD', 'John Smith', 'John', 'Smith'],
  ['Jane Doe, MBA, PMP', 'Jane Doe', 'Jane', 'Doe'],
  ['Dr. Juan Q. Xavier de la Vega III', 'Juan Q. Xavier de la Vega', 'Juan', 'de la Vega'],
  ['Mr. Johnson', 'Johnson', '', 'Johnson'],
  ['Robert (Bob) Jones', 'Robert Jones', 'Robert', 'Jones'],
  ["William 'Bill' O'Reilly", "William O'Reilly", 'William', "O'Reilly"],
  ["MARY O'BRIEN", "Mary O'Brien", 'Mary', "O'Brien"],
  ["mary d'angelo", "Mary D'Angelo", 'Mary', "D'Angelo"],
  ['RONALD MCDONALD', 'Ronald McDonald', 'Ronald', 'McDonald'],
  ['angus macdonald', 'Angus MacDonald', 'Angus', 'MacDonald'],
  ['sam macey', 'Sam Macey', 'Sam', 'Macey'],
  ['ana machado', 'Ana Machado', 'Ana', 'Machado'],
  ['john mackey', 'John Mackey', 'John', 'Mackey'],
  ['LUDWIG VAN BEETHOVEN', 'Ludwig van Beethoven', 'Ludwig', 'van Beethoven'],
  // A capitalized particle in first place is a first name.
  ['VAN MORRISON', 'Van Morrison', 'Van', 'Morrison'],
  ['AL GORE', 'Al Gore', 'Al', 'Gore'],
  ['MARY ST. CLAIR', 'Mary St. Clair', 'Mary', 'St. Clair'],
  ['LIV TYLER', 'Liv Tyler', 'Liv', 'Tyler'],
  ['xi jinping', 'Xi Jinping', 'Xi', 'Jinping'],
  ['andrew ng', 'Andrew Ng', 'Andrew', 'Ng'],
  ['JJ ABRAMS', 'JJ Abrams', 'JJ', 'Abrams'],
  ['DeShawn Jackson', 'DeShawn Jackson', 'DeShawn', 'Jackson'],
  // Mixed case is kept, but the last-name cleaner writes particles in lower case.
  ['Vincent Van Gogh', 'Vincent Van Gogh', 'Vincent', 'van Gogh'],
  ['jean-luc picard', 'Jean-Luc Picard', 'Jean-Luc', 'Picard'],
  // A lone word is a first name. The last-name cleaner reads a lone word as a
  // last name, so its own output ("Johnson" from "Mr. Johnson") cleans to itself.
  ['Cher', 'Cher', 'Cher', 'Cher'],
  // Added.
  ['', '', '', ''],
  ['   ', '', '', ''],
  ['Smith, John, Jr.', 'John Smith', 'John', 'Smith'],
  ['SMITH, JOHN', 'John Smith', 'John', 'Smith'],
  // Last name first is put in natural order, then read like any name.
  ['SMITH JONES, MARY', 'Mary Smith Jones', 'Mary', 'Jones'],
  ['de la Vega, Juan', 'Juan de la Vega', 'Juan', 'de la Vega'],
  ['Smith, Dr. John', 'John Smith', 'John', 'Smith'],
  ['John Smith, M.D.', 'John Smith', 'John', 'Smith'],
  ['Jane Doe, CPA', 'Jane Doe', 'Jane', 'Doe'],
  ['Jane Doe, DO', 'Jane Doe', 'Jane', 'Doe'],
  ['Kim, Ed', 'Ed Kim', 'Ed', 'Kim'],
  ['Jane Do', 'Jane Do', 'Jane', 'Do'],
  ['Prof. Dr. Hans Müller', 'Hans Müller', 'Hans', 'Müller'],
  ['Sir Elton John', 'Elton John', 'Elton', 'John'],
  ['King Charles', 'King Charles', 'King', 'Charles'],
  ['Mr', 'Mr', 'Mr', 'Mr'],
  ['mr. de la vega', 'de la Vega', '', 'de la Vega'],
  ['Martin Luther King Jr.', 'Martin Luther King', 'Martin', 'King'],
  ['John Smith III', 'John Smith', 'John', 'Smith'],
  ['William "Bill" Gates', 'William Gates', 'William', 'Gates'],
  ['"Jane Doe"', 'Jane Doe', 'Jane', 'Doe'],
  ['DELLA REESE', 'Della Reese', 'Della', 'Reese'],
  ['JOHN LE', 'John Le', 'John', 'Le'],
  ['OSAMA BIN LADEN', 'Osama bin Laden', 'Osama', 'bin Laden'],
  ['juan pérez y garcía', 'Juan Pérez Y García', 'Juan', 'García'],
  ['MARY SMITH-JONES', 'Mary Smith-Jones', 'Mary', 'Smith-Jones'],
  ['tj miller', 'TJ Miller', 'TJ', 'Miller'],
  ['j.r.r. tolkien', 'J.R.R. Tolkien', 'J.R.R.', 'Tolkien'],
  ["DENNIS O'NEIL'S", "Dennis O'Neil's", 'Dennis', "O'Neil's"],
  ['MAC MILLER', 'Mac Miller', 'Mac', 'Miller'],
  ['IAN MACISAAC', 'Ian MacIsaac', 'Ian', 'MacIsaac'],
  ['EMMANUEL MACRON', 'Emmanuel Macron', 'Emmanuel', 'Macron'],
  ['LaToya Jackson', 'LaToya Jackson', 'LaToya', 'Jackson'],
  ['john@acme.com', '', '', ''],
  // A name that starts with a lower-case particle (in a name with capitals) or
  // with St. is a last name only; a capitalized particle is a first name.
  ['Van Morrison', 'Van Morrison', 'Van', 'Morrison'],
  ['Della Reese', 'Della Reese', 'Della', 'Reese'],
  ['Di Wang', 'Di Wang', 'Di', 'Wang'],
  ['Da Li', 'Da Li', 'Da', 'Li'],
  ['Le Tran', 'Le Tran', 'Le', 'Tran'],
  ['van Beethoven', 'van Beethoven', '', 'van Beethoven'],
  ['de la Vega', 'de la Vega', '', 'de la Vega'],
  ['bin Laden', 'bin Laden', '', 'bin Laden'],
  ['de Souza Santos', 'de Souza Santos', '', 'de Souza Santos'],
  ['St. Clair', 'St. Clair', '', 'St. Clair'],
  ['ST. CLAIR', 'St. Clair', '', 'St. Clair'],
  ['van beethoven', 'Van Beethoven', 'Van', 'Beethoven'],
  ['Maria De La Cruz', 'Maria De La Cruz', 'Maria', 'de la Cruz'],
  ['Johnson', 'Johnson', 'Johnson', 'Johnson'],
  ['Mr. Van Morrison', 'Van Morrison', '', 'van Morrison'],
  // Word by word: a word all in capitals or all in lower case is recased,
  // one in mixed case is kept.
  ['John SMITH', 'John Smith', 'John', 'Smith'],
  ['Jean-Luc PICARD', 'Jean-Luc Picard', 'Jean-Luc', 'Picard'],
  ["Mary O'BRIEN", "Mary O'Brien", 'Mary', "O'Brien"],
  ['John VAN DYKE', 'John van Dyke', 'John', 'van Dyke'],
  ['Jean DE LA FONTAINE', 'Jean de la Fontaine', 'Jean', 'de la Fontaine'],
  ['DeShawn JACKSON', 'DeShawn Jackson', 'DeShawn', 'Jackson'],
  ['jean DUPONT', 'Jean Dupont', 'Jean', 'Dupont'],
  ['DUPONT, Jean', 'Jean Dupont', 'Jean', 'Dupont'],
  ['john q. SMITH', 'John Q. Smith', 'John', 'Smith'],
  // A Mc, Mac, O' or D' before capitals counts as capitals; other mixed case stays.
  ['McDONALD, ronald', 'Ronald McDonald', 'Ronald', 'McDonald'],
  ['Angus MacDONALD', 'Angus MacDonald', 'Angus', 'MacDonald'],
  ['Ronald McDONALD', 'Ronald McDonald', 'Ronald', 'McDonald'],
  ["Mary o'BRIEN", "Mary O'Brien", 'Mary', "O'Brien"],
  ["Mary D'ANGELO", "Mary D'Angelo", 'Mary', "D'Angelo"],
  ['Kate MacKENZIE', 'Kate MacKenzie', 'Kate', 'MacKenzie'],
  ['MacDONALD, Angus', 'Angus MacDonald', 'Angus', 'MacDonald'],
  ['KATE MACKENZIE', 'Kate Mackenzie', 'Kate', 'Mackenzie'],
  ['Ronald McDonald', 'Ronald McDonald', 'Ronald', 'McDonald'],
  ['Kate MacKenzie', 'Kate MacKenzie', 'Kate', 'MacKenzie'],
  ["Shaquille O'Neal", "Shaquille O'Neal", 'Shaquille', "O'Neal"],
  // Two capitals before the last name are initials, unless the whole name is
  // in capitals; a lone word can't tell, so it stays.
  ['AJ Styles', 'AJ Styles', 'AJ', 'Styles'],
  ['TJ Miller', 'TJ Miller', 'TJ', 'Miller'],
  ['John DJ Smith', 'John DJ Smith', 'John', 'Smith'],
  ['ED SHEERAN', 'Ed Sheeran', 'Ed', 'Sheeran'],
  ['BO JACKSON', 'Bo Jackson', 'Bo', 'Jackson'],
  ['AJ', 'AJ', 'AJ', 'Aj'],
]
for (const [input, full, first, last] of cases) {
  expectClean('full', cleanPersonName, input, full)
  expectClean('first', cleanFirstName, input, first)
  expectClean('last', cleanLastName, input, last)
}

// A cleaned last name cleans to itself, particles and all.
for (const last of ['van Beethoven', 'de la Vega', 'St. Clair', 'van Gogh', 'bin Laden', "O'Brien", 'Smith-Jones']) {
  expectClean('last', cleanLastName, last, last)
}
for (const f of [cleanPersonName, cleanFirstName, cleanLastName]) {
  check(`${f.name}: very long input → blank`, f(`John ${'x'.repeat(2000)}`) === '')
  check(`${f.name}: not a string → blank`, f(undefined as unknown as string) === '')
}

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall clean-person-name checks passed')
