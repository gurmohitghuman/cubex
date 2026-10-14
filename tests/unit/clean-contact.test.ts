// Unit test for lib/clean/email.ts, domain.ts and phone.ts. Every case also
// cleans its own output again, which must change nothing (auto-run cleans
// rows again). server/src is type:commonjs → default-import + destructure under tsx.
// Over 200 lines: three case tables (email, domain, phone) sharing one harness.
import emailMod from '../../server/src/lib/clean/email'
import domainMod from '../../server/src/lib/clean/domain'
import phoneMod from '../../server/src/lib/clean/phone'
const { cleanEmail } = emailMod as typeof import('../../server/src/lib/clean/email')
const { cleanDomain } = domainMod as typeof import('../../server/src/lib/clean/domain')
const { cleanPhone, isPhoneCountry } = phoneMod as typeof import('../../server/src/lib/clean/phone')
type CountryCode = import('../../server/src/lib/clean/phone').CountryCode

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
const cp = (...codes: number[]) => String.fromCodePoint(...codes)

// --- email -------------------------------------------------------------------
const emails: [string, string][] = [
  ['  John.Smith@Acme.COM ', 'john.smith@acme.com'],
  ['mailto:john@acme.com?subject=Hi', 'john@acme.com'],
  ['John Smith <john@acme.com>', 'john@acme.com'],
  ['john@acme.com.', 'john@acme.com'],
  ['john+leads@acme.com', 'john+leads@acme.com'],
  ['j.o.h.n@gmail.com', 'j.o.h.n@gmail.com'],
  ['john@münchen.de', 'john@münchen.de'],
  ['john..smith@acme.com', ''],
  ['.john@acme.com', ''],
  ['john.@acme.com', ''],
  ['john@acme', ''],
  ['john@localhost', ''],
  ['john smith@acme.com', ''],
  ['john@acme.c', ''],
  ['john@acme.123', ''],
  ['john@1.2.3.4', ''],
  ['john@[1.2.3.4]', ''],
  ['john@acme_corp.com', ''],
  ['a@x.com; b@x.com', ''],
  [`${'a'.repeat(65)}@x.com`, ''],
  ['N/A', ''],
  // Added.
  ['', ''],
  [`${'a'.repeat(64)}@x.com`, `${'a'.repeat(64)}@x.com`],
  [`${cp(0xFEFF)}john@acme.com${cp(0x200B)}`, 'john@acme.com'],
  ['"john@acme.com",', 'john@acme.com'],
  ['(john@acme.com)', 'john@acme.com'],
  ['<MAILTO:John@Acme.com>', 'john@acme.com'],
  ['"Smith, John" <john@acme.com>', 'john@acme.com'],
  ["o'brien@acme.ie", "o'brien@acme.ie"],
  ['john@MÜNCHEN.DE', 'john@münchen.de'],
  ['john@xn--mnchen-3ya.de', 'john@xn--mnchen-3ya.de'],
  ['john@acme.co.uk', 'john@acme.co.uk'],
  ['john@-acme.com', ''],
  ['john@acme-.com', ''],
  ['josé@acme.com', ''],
  ['"john smith"@acme.com', ''],
  ['a@x.com b@x.com', ''],
  ['john@@acme.com', ''],
  ['@acme.com', ''],
  ['john@', ''],
  [`john@${'a'.repeat(64)}.com`, ''],
]
for (const [input, want] of emails) expectClean('email', cleanEmail, input, want)
check('email: very long input → blank', cleanEmail(`${'a'.repeat(2000)}@x.com`) === '')

// --- domain ------------------------------------------------------------------
const domains: [string, string][] = [
  ['https://www.Acme.com/about?x=1', 'acme.com'],
  ['acme.com/', 'acme.com'],
  ['www.acme.com', 'acme.com'],
  ['www2.acme.com', 'acme.com'],
  ['http://acme.com:8080', 'acme.com'],
  ['user@acme.com', 'acme.com'],
  ['mailto:user@acme.com', 'acme.com'],
  ['Acme.com.', 'acme.com'],
  ['HTTPS://WWW.ACME.COM', 'acme.com'],
  ['<https://acme.com>', 'acme.com'],
  ['acme.com,', 'acme.com'],
  ['blog.acme.co.uk', 'acme.co.uk'],
  ['https://shop.acme.com.au/x', 'acme.com.au'],
  ['linkedin.com/company/acme', 'linkedin.com'],
  ['acme.myshopify.com', 'acme.myshopify.com'],
  ['acme.github.io', 'acme.github.io'],
  ['192.168.0.1', ''],
  ['http://[::1]/', ''],
  ['localhost', ''],
  ['acme.local', ''],
  ['acme.internal', ''],
  ['acme', ''],
  ['co.uk', ''],
  ['github.io', ''],
  ['acme .com', ''],
  ['http//acme.com', ''],
  ['xn--mnchen-3ya.de', 'münchen.de'],
  ['münchen.de', 'münchen.de'],
  // Added.
  ['', ''],
  ['N/A', ''],
  ['www.myshopify.com', ''],
  ['https://user:pass@www.acme.io/x#top', 'acme.io'],
  ['"acme.com";', 'acme.com'],
  ['(www.acme.com)', 'acme.com'],
  ['MÜNCHEN.DE', 'münchen.de'],
  ['a.b.c.acme.com', 'acme.com'],
  ['www.com', 'www.com'],
  ['acme_corp.com', ''],
  ['acme.123', ''],
  ['http://10.0.0.1:8080/admin', ''],
  ['ftp://files.acme.org/pub', 'acme.org'],
]
for (const [input, want] of domains) expectClean('domain', cleanDomain, input, want)
check('domain: very long input → blank', cleanDomain(`${'a'.repeat(2000)}.com`) === '')

// --- phone -------------------------------------------------------------------
// [input, national, e164] with the default country US. Expected outputs match
// libphonenumber-js/max 1.13.15 (validity uses its assigned area codes).
const usPhones: [string, string, string][] = [
  ['(212) 555-0123', '(212) 555-0123', '+12125550123'],
  ['212.555.0123', '(212) 555-0123', '+12125550123'],
  ['2125550123', '(212) 555-0123', '+12125550123'],
  ['1-212-555-0123', '(212) 555-0123', '+12125550123'],
  ['+1 (212) 555-0123', '(212) 555-0123', '+12125550123'],
  ['tel:+1-212-555-0123', '(212) 555-0123', '+12125550123'],
  ['＋１ ２１２ ５５５ ０１２３', '(212) 555-0123', '+12125550123'],
  ['212 555 0123 x123', '(212) 555-0123 ext. 123', '+12125550123'],
  ['212-555-0123 #9', '(212) 555-0123 ext. 9', '+12125550123'],
  ['416-555-0123', '(416) 555-0123', '+14165550123'],
  ['1-800-356-9377', '(800) 356-9377', '+18003569377'],
  ['1-800-FLOWERS', '(800) 356-9377', '+18003569377'],
  // A foreign number: the international form in national mode.
  ['+44 20 7946 0958', '+44 20 7946 0958', '+442079460958'],
  ['011 44 20 7946 0958', '+44 20 7946 0958', '+442079460958'],
  ['020 7946 0958', '', ''],
  ['(555) 123-4567', '', ''],
  ['123-456-7890', '', ''],
  ['212-155-0123', '', ''],
  ['911-555-0123', '', ''],
  ['212-555-012', '', ''],
  ['212-555-01234', '', ''],
  ['N/A', '', ''],
  // Added.
  ['', '', ''],
  ['(011) 555-0123', '', ''],
  ['2125550123.0', '(212) 555-0123', '+12125550123'],
  ['2.12555E+09', '', ''],
  ['Phone: 212-555-0123', '(212) 555-0123', '+12125550123'],
  ['212-555-0123 ext. 45', '(212) 555-0123 ext. 45', '+12125550123'],
  ['212-555-0123;ext=55', '(212) 555-0123 ext. 55', '+12125550123'],
  ['1 (800) GOT-JUNK x12', '(800) 468-5865 ext. 12', '+18004685865'],
  ['(876) 555-0123', '(876) 555-0123', '+18765550123'],
  ['+44 20 7946 0958 x12', '+44 20 7946 0958 x12', '+442079460958'],
  ['+55 11 91234-5678', '+55 11 91234 5678', '+5511912345678'],
  ['44 20 7946 0958', '', ''],
  ['212-555-0123 or 212-555-9999', '', ''],
  ['abc', '', ''],
]
for (const [input, national, e164] of usPhones) {
  expectClean('phone national', v => cleanPhone(v, 'national'), input, national)
  expectClean('phone e164', v => cleanPhone(v, 'e164'), input, e164)
}
const international: [string, string][] = [
  ['(212) 555-0123', '+1 212 555 0123'],
  ['212 555 0123 x123', '+1 212 555 0123 ext. 123'],
  ['416-555-0123', '+1 416 555 0123'],
  ['+44 20 7946 0958', '+44 20 7946 0958'],
  ['020 7946 0958', ''],
]
for (const [input, want] of international) {
  expectClean('phone international', v => cleanPhone(v, 'international'), input, want)
}
// Another default country: bare digits are its numbers, a US number is foreign.
const other: [string, CountryCode, 'national' | 'international' | 'e164', string][] = [
  ['020 7946 0958', 'GB', 'national', '020 7946 0958'],
  ['020 7946 0958', 'GB', 'e164', '+442079460958'],
  ['020 7946 0958', 'GB', 'international', '+44 20 7946 0958'],
  ['+44 20 7946 0958', 'GB', 'national', '020 7946 0958'],
  ['07946 095800', 'GB', 'national', '07946 095800'],
  ['+1 212 555 0123', 'GB', 'national', '+1 212 555 0123'],
  ['(212) 555-0123', 'GB', 'national', ''],
  ['00 1 212 555 0123', 'GB', 'e164', '+12125550123'],
  ['030 123456', 'DE', 'national', '030 123456'],
  ['(11) 91234-5678', 'BR', 'national', '(11) 91234-5678'],
  // In Brazil "(011)" is São Paulo's area code with its trunk 0, not an exit
  // code: the short-after-011 rule is NANP's only.
  ['(011) 91234-5678', 'BR', 'e164', '+5511912345678'],
  ['8 (495) 123-45-67', 'RU', 'international', '+7 495 123 45 67'],
  // Canada shares calling code 1 with the US: national, and 011 is its exit code.
  ['(212) 555-0123', 'CA', 'national', '(212) 555-0123'],
  ['(011) 555-0123', 'CA', 'national', ''],
]
for (const [input, country, format, want] of other) {
  expectClean(`phone ${format} ${country}`, v => cleanPhone(v, format, country), input, want)
}
check('phone: very long input → blank', cleanPhone(`212-555-0123 ${'x'.repeat(2000)}`, 'national') === '')
check('phone: unknown country → blank, no throw', cleanPhone('2125550123', 'national', 'XX' as CountryCode) === '')
check('isPhoneCountry US', isPhoneCountry('US'))
check('isPhoneCountry GB', isPhoneCountry('GB'))
check('isPhoneCountry rejects lower case', !isPhoneCountry('us'))
check('isPhoneCountry rejects XX', !isPhoneCountry('XX'))
check('isPhoneCountry rejects a number', !isPhoneCountry(1))

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall clean-contact checks passed')
