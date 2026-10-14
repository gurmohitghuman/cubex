// Phone cleaner (pure): one valid phone number in a fixed format, or ''.
// Validity comes from the full metadata (assigned area codes and number
// lengths), so 555 and N11 area codes or a digit too many give ''.
import {
  getCountryCallingCode, isSupportedCountry, parsePhoneNumberFromString, type CountryCode, type PhoneNumber,
} from 'libphonenumber-js/max';
import { MAX_CLEAN_FIELD_CHARS } from '../constants-clean';
import { cleanTrim } from './text';

// national: "(212) 555-0123" for a number of the default country's calling
// code (all of NANP for US), the international form for any other.
// international: "+1 212 555 0123". e164: "+12125550123", no extension.
export type PhoneFormat = 'national' | 'international' | 'e164';
export type { CountryCode };

export const isPhoneCountry = (x: unknown): x is CountryCode => typeof x === 'string' && isSupportedCountry(x);

// A spreadsheet that read the number as a float: "2.12555E+09" lost digits
// (''), "2125550123.0" just gained a decimal.
const SCIENTIFIC = /^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i;
const FLOAT_TAIL = /^(\+?\d+)\.0+$/;
// An extension at the end: "x123", "ext. 123", "extension 5", "#9", ";ext=5".
const EXTENSION = /\s*[,;]?\s*(?:ext(?:ension)?\.?|ext=|x\.?|#)\s*(\d{1,10})\s*$/i;
const KEYPAD: Record<string, string> = {};
['abc', 'def', 'ghi', 'jkl', 'mno', 'pqrs', 'tuv', 'wxyz'].forEach((letters, i) => {
  for (const c of letters) KEYPAD[c] = String(i + 2);
});

const splitExtension = (s: string): [string, string] => {
  const m = EXTENSION.exec(s);
  return m ? [s.slice(0, m.index), m[1]] : [s, ''];
};

// "1-800-FLOWERS" → "1-800-3569377". Only with three letters or more in the
// number itself, so a stray letter isn't dialed.
function vanityToDigits(s: string): string {
  const [number, ext] = splitExtension(s);
  if ((number.match(/[a-z]/gi) ?? []).length < 3) return '';
  const digits = number.replace(/[a-z]/gi, c => KEYPAD[c.toLowerCase()]);
  return ext ? `${digits} ext. ${ext}` : digits;
}

// "(011) 555-0123": 011 is the exit code of NANP, but seven digits after it
// is a mistyped local number, not a call abroad (it would read as Brazil).
// The few countries with numbers that short abroad lose them here.
function shortAfterExitCode(s: string): boolean {
  const [number] = splitExtension(s);
  if (number.includes('+')) return false;
  const digits = number.replace(/\D/g, '');
  return digits.startsWith('011') && digits.length <= 10;
}

function readValid(s: string, country: CountryCode): PhoneNumber | null {
  if (!s) return null;
  try {
    const phone = parsePhoneNumberFromString(s, country);
    return phone && phone.isValid() ? phone : null;
  } catch {
    return null;
  }
}

// Bare digits are read as numbers of `country`; only "+" or the country's exit
// code (011 for US) makes a number foreign.
export function cleanPhone(value: string, format: PhoneFormat, country: CountryCode = 'US'): string {
  let s = cleanTrim(value).normalize('NFKC');
  if (!s || s.length > MAX_CLEAN_FIELD_CHARS || SCIENTIFIC.test(s) || !isPhoneCountry(country)) return '';
  s = s.replace(FLOAT_TAIL, '$1').replace(/^tel:/i, '');
  const home = getCountryCallingCode(country);
  if (home === '1' && shortAfterExitCode(s)) return '';
  const phone = readValid(s, country) ?? readValid(vanityToDigits(s), country);
  if (!phone) return '';
  if (format === 'e164') return phone.number;
  if (format === 'national' && phone.countryCallingCode === home) return phone.formatNational();
  return phone.formatInternational();
}
