// Unit test for lib/clean/company.ts. Every case also cleans its own output
// again, which must change nothing (auto-run cleans rows again).
// server/src is type:commonjs → default-import + destructure under tsx.
import companyMod from '../../server/src/lib/clean/company'
const { cleanCompanyName } = companyMod as typeof import('../../server/src/lib/clean/company')

let failures = 0
function check(label: string, cond: boolean) {
  if (cond) console.log('ok  ', label)
  else { failures++; console.log('FAIL', label) }
}
function expectClean(input: string, want: string) {
  const got = cleanCompanyName(input)
  const note = got === want ? '' : ` (got ${JSON.stringify(got)})`
  check(`company ${JSON.stringify(input)} → ${JSON.stringify(want)}${note}`, got === want)
  check(`company idempotent on ${JSON.stringify(got)}`, cleanCompanyName(got) === got)
}

const cases: [string, string][] = [
  ['Acme, Inc.', 'Acme'],
  ['ACME INC', 'Acme'],
  ['AT&T Inc.', 'AT&T'],
  ['eBay Inc', 'eBay'],
  ['ibm', 'IBM'],
  ['IBM', 'IBM'],
  ['3M Co', '3M'],
  ['Procter & Gamble Co.', 'Procter & Gamble'],
  ['The Coca-Cola Company', 'Coca-Cola'],
  ['Incubator Ltd', 'Incubator'],
  ['Corporate Solutions LLC', 'Corporate Solutions'],
  ['Foo Holdings, Inc.', 'Foo Holdings'],
  ['Acme Co., Ltd.', 'Acme'],
  ['Goldman Sachs & Co. LLC', 'Goldman Sachs'],
  ['JPMorgan Chase & Co.', 'JPMorgan Chase'],
  ['Telstra Corporation Limited', 'Telstra'],
  ['Siemens AG', 'Siemens'],
  ['Nestlé S.A.', 'Nestlé'],
  ['Ferrari N.V.', 'Ferrari'],
  ['Atlassian Pty Ltd', 'Atlassian'],
  ['Acme (Pty) Ltd', 'Acme'],
  ['BANK OF AMERICA CORPORATION', 'Bank of America'],
  ['HSBC HOLDINGS PLC', 'HSBC Holdings'],
  ['Yahoo!', 'Yahoo!'],
  ['Sky UK', 'Sky UK'],
  ['Company', 'Company'],
  ['Inc.', 'Inc.'],
  ['Limited Brands', 'Limited Brands'],
  ['The Walt Disney Company', 'Walt Disney'],
  ['The Home Depot, Inc.', 'The Home Depot'],
  ['Acme, Inc. (NYSE: ACM)', 'Acme'],
  // A clause saying whom the company belongs to.
  ['Cora, a company of Blank', 'Cora'],
  ['Acme, a subsidiary of Foo Inc.', 'Acme'],
  ['Acme, Inc., a division of Foo', 'Acme'],
  ['Acme, A Wholly-Owned Subsidiary of Foo', 'Acme'],
  ['Acme, an affiliate of Foo', 'Acme, an affiliate of Foo'],
  ['Smith, Jones & Co', 'Smith, Jones'],
  // Added.
  ['', ''],
  ['   ', ''],
  ['MCKINSEY & COMPANY', 'McKinsey'],
  ["MACY'S, INC.", "Macy's"],
  ['acme (uk) ltd', 'Acme'],
  ['The Limited', 'The Limited'],
  ['The Company', 'The Company'],
  ['Company Inc.', 'Company'],
  ['Acme GmbH & Co. KG', 'Acme'],
  ['Grupo Bimbo, S.A. de C.V.', 'Grupo Bimbo'],
  ['acme pvt ltd', 'Acme'],
  ['Infosys Private Limited', 'Infosys'],
  ['Spotify AB', 'Spotify'],
  ['Maersk A/S', 'Maersk'],
  ['Nokia Oyj', 'Nokia'],
  ['Acme Holdings Group', 'Acme Holdings Group'],
  ['Acme International', 'Acme International'],
  ['J.P. MORGAN', 'J.P. Morgan'],
  ['KPMG LLP', 'KPMG'],
  ['DHL EXPRESS', 'DHL Express'],
  ['the kroger co.', 'Kroger'],
  ['bed bath & beyond inc', 'Bed Bath & Beyond'],
  ['p&g', 'P&G'],
  ['COCA-COLA', 'Coca-Cola'],
  ['iRobot Corp.', 'iRobot'],
  ['HubSpot, Inc.', 'HubSpot'],
  ['Inc. Magazine', 'Inc. Magazine'],
  ['Société Générale S.A.', 'Société Générale'],
  ['Acme Corp. (formerly Foo)', 'Acme'],
  ['(Acme)', '(Acme)'],
]
for (const [input, want] of cases) expectClean(input, want)
check('company: very long input → blank', cleanCompanyName(`Acme ${'x'.repeat(2000)} Inc`) === '')
check('company: not a string → blank', cleanCompanyName(undefined as unknown as string) === '')

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall clean-company checks passed')
